// Refresh in the Model menu (#565, docs/design/bots.md section 9): a person's
// press asks the gateway to look for the provider's models again, the row says
// it is looking and can't be pressed twice, and one line says what changed or
// the most specific reason nothing did, said once to a screen reader while focus
// stays in the menu. Every other sentence is one step away, behind a small item
// on that line. The fixture's answers are held until the check lets them through.
import type { Page } from "@playwright/test";
import { contextFor, expect, openFixture, OTTO_DISK, settle, SIZES, THEMES } from "./fixture.ts";
import { test } from "@playwright/test";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const PHONE = SIZES.find((size) => size.phone)!;
const SETTINGS = `scene=main&${OTTO_DISK}&access=admin&panel=open&tab=settings`;

const sent = (page: Page) =>
  page.evaluate(() =>
    (
      window as unknown as { clawtrateFixture: { sent: Array<Record<string, unknown>> } }
    ).clawtrateFixture.sent.filter((each) => each.type === "refreshModels"),
  );
const releaseRefresh = (page: Page) =>
  page.evaluate(() => (window as unknown as { releaseRefresh: () => void }).releaseRefresh());
/** Every text the polite announcer was given, from now on. */
const recordAnnouncements = (page: Page) =>
  page.evaluate(() => {
    const said: string[] = [];
    (window as unknown as { said: string[] }).said = said;
    for (const node of document.querySelectorAll('[data-testid$="announcer"]'))
      new MutationObserver(() => {
        const text = node.textContent ?? "";
        if (text) said.push(text);
      }).observe(node, { childList: true, characterData: true, subtree: true });
  });
const announcements = (page: Page) =>
  page.evaluate(() => [...(window as unknown as { said: string[] }).said]);

const menu = (page: Page) => page.getByRole("menu", { name: "Model" });
const refreshRow = (page: Page) => menu(page).getByRole("menuitem", { name: "Refresh" });
const why = (page: Page) => menu(page).getByRole("menuitem", { name: "Why", exact: true });
/** The text under the line, once "Why" shows it. */
const panel = (page: Page) => menu(page).locator(".menu-panel");

/** Refresh pressed from the keyboard, so no pointer rests on a row. */
async function press(page: Page) {
  await refreshRow(page).focus();
  await page.keyboard.press("Enter");
}

async function openMenu(page: Page, query: string, theme: "light" | "dark" = "light") {
  await openFixture(page, query, theme);
  await page.getByTestId("model-select").click();
  await expect(menu(page)).toBeVisible();
}

test.describe("F-588: Refresh in the Model menu", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-588: Refresh asks on a press only, says it is looking, can't be pressed twice, and says once what it found while focus stays in the menu", async ({
    page,
  }) => {
    await openMenu(page, `${SETTINGS}&refresh=slow`);
    // Opening the menu asks nothing.
    expect(await sent(page)).toEqual([]);
    await expect(refreshRow(page)).toHaveAccessibleDescription("Look for new models");
    await recordAnnouncements(page);
    // By keyboard: the row before View more.
    await refreshRow(page).focus();
    await page.keyboard.press("Enter");
    await expect(refreshRow(page)).toHaveAccessibleDescription("Looking…");
    await expect(refreshRow(page)).toHaveAttribute("aria-disabled", "true");
    await expect(refreshRow(page)).toBeFocused();
    await page.keyboard.press("Enter");
    // A pointer on the row while it looks does nothing either.
    await refreshRow(page).click({ force: true });
    const asked = await sent(page);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ type: "refreshModels", provider: "openai" });
    expect(asked[0]!.stamp).toMatchObject({ gatewayId: expect.any(String) });
    await releaseRefresh(page);
    const line = "New: gpt-6.2-sol and gpt-6.2-astra.";
    await expect(menu(page).getByText(line)).toBeVisible();
    // The new models are in the menu, in the gateway's order, and can be chosen.
    await expect(menu(page).getByRole("menuitemradio", { name: "gpt-6.2-sol" })).toBeVisible();
    await expect(refreshRow(page)).toHaveAccessibleDescription("Look for new models");
    await expect(refreshRow(page)).toBeFocused();
    await expect.poll(() => announcements(page)).toEqual([line]);
    // Closing and opening the menu shows the line again, and says nothing again.
    await page.keyboard.press("Escape");
    await page.getByTestId("model-select").click();
    await expect(menu(page).getByText(line)).toBeVisible();
    await page.waitForTimeout(200);
    expect(await announcements(page)).toEqual([line]);
  });

  test("F-588: each outcome in its own words", async ({ page }) => {
    const cases: Array<[string, string]> = [
      [
        "many",
        "New: gpt-6.2-sol, gpt-6.2-astra, gpt-6.2-luna, gpt-6.2-terra, gpt-6.2-nova and 2 more.",
      ],
      ["gone", "No longer listed: gpt-5.5-mini."],
      ["asked", "Nothing new. The gateway asked OpenAI again, and its list is the same."],
      ["config", "Nothing new. OpenAI's models are the ones the gateway's config lists."],
      ["refused", "Nothing new. The gateway couldn't ask OpenAI: OpenAI refused the account."],
      ["unreached", "Nothing new. The gateway couldn't get an answer from OpenAI."],
      ["pending", "Nothing new yet. The gateway is still looking for OpenAI's models."],
      ["failed", "Nothing new. The gateway's refresh failed: try Refresh again."],
      ["cut", "OpenAI lists 141 models now (140 before)."],
      ["error", "Couldn't refresh: The gateway didn't answer in time."],
      ["none", "Nothing new. The gateway didn't ask OpenAI again, so its list is the one it had."],
    ];
    for (const [refresh, words] of cases) {
      await openMenu(page, `${SETTINGS}&refresh=${refresh}`);
      await refreshRow(page).click();
      await expect(menu(page).getByText(words, { exact: true }), refresh).toBeVisible();
      // These have nothing more to say.
      if (refresh !== "none") await expect(why(page), refresh).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    // The rest of "nothing new" is one step away, the note under the menu included.
    const online =
      "Lists that come with OpenClaw get newer models from a newer OpenClaw, and from OpenClaw's model list online, which the gateway checks every 6 hours.";
    const typeIt = "To use a model that isn't listed, choose Use another model and type its id.";
    for (const [query, more] of [
      ["", [online, typeIt]],
      ["&openclaw=behind", [online, "OpenClaw 2026.11.6 is out: see the note below.", typeIt]],
    ] as const) {
      await openMenu(page, `${SETTINGS}&refresh=none${query}`);
      await refreshRow(page).click();
      await expect(panel(page)).toHaveCount(0);
      await why(page).click();
      await expect(panel(page).locator("p")).toHaveText([...more]);
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");
    }
    // The note the line points to is the one under the menu.
    await expect(page.getByTestId("openclaw-update")).toBeVisible();
  });

  test("F-588: Why opens the rest by keyboard, is not said again, keeps focus, and Escape closes it before the menu", async ({
    page,
  }) => {
    await openMenu(page, `${SETTINGS}&refresh=none`);
    await recordAnnouncements(page);
    await press(page);
    const line = "Nothing new. The gateway didn't ask OpenAI again, so its list is the one it had.";
    await expect(menu(page).getByText(line, { exact: true })).toBeVisible();
    await expect(refreshRow(page)).toBeFocused();
    // The next item after Refresh is Why, on the line.
    await page.keyboard.press("ArrowDown");
    await expect(why(page)).toBeFocused();
    await expect(why(page)).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press("Enter");
    await expect(why(page)).toHaveAttribute("aria-expanded", "true");
    await expect(why(page)).toBeFocused();
    await expect(panel(page)).toBeVisible();
    // Read with the item it belongs to, and never into the announcer.
    await expect(why(page)).toHaveAccessibleDescription(/^Lists that come with OpenClaw/);
    await page.waitForTimeout(200);
    expect(await announcements(page)).toEqual([line]);
    // Escape closes the panel first, then the menu.
    await page.keyboard.press("Escape");
    await expect(panel(page)).toHaveCount(0);
    await expect(menu(page)).toBeVisible();
    await expect(why(page)).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu(page)).toHaveCount(0);
    await expect(page.getByTestId("model-select")).toBeFocused();
    // Opened again: the line, with the panel closed.
    await page.getByTestId("model-select").click();
    await expect(menu(page).getByText(line, { exact: true })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
  });

  test("F-588: when the gateway's config names the models bots may use, the menu says so, and only then", async ({
    page,
  }) => {
    const words =
      "The gateway's config names which of OpenAI's models it lists and lets a task switch to; a bot's own model can still be one it doesn't name.";
    await openMenu(page, `${SETTINGS}&allowlist=1`);
    // At rest the menu has no paragraph.
    await expect(menu(page).getByText(words)).toHaveCount(0);
    await expect(menu(page).locator(".menu-line, .menu-panel")).toHaveCount(0);
    await recordAnnouncements(page);
    await refreshRow(page).click();
    // Nothing new: the list is the reason a model may not be there, so the line gives it.
    await expect.poll(() => announcements(page)).toEqual([`Nothing new. ${words}`]);
    await why(page).click();
    await expect(panel(page).locator("p").first()).toHaveText(
      "The gateway didn't ask OpenAI again, so its list is the one it had.",
    );
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // Something new: the list is one step away.
    await openMenu(page, `${SETTINGS}&allowlist=1&refresh=new`);
    await refreshRow(page).click();
    await expect(
      menu(page).getByText("New: gpt-6.2-sol and gpt-6.2-astra.", { exact: true }),
    ).toBeVisible();
    await expect(menu(page).getByText(words)).toHaveCount(0);
    await menu(page).getByRole("menuitem", { name: "More", exact: true }).click();
    await expect(panel(page).locator("p")).toHaveText([words]);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await openMenu(page, SETTINGS);
    await refreshRow(page).click();
    await why(page).click();
    await expect(menu(page).getByText(words)).toHaveCount(0);
  });

  test("F-588: a second Refresh that finds the same models says nothing new and lists each once", async ({
    page,
  }) => {
    await openMenu(page, `${SETTINGS}&refresh=new`);
    await refreshRow(page).click();
    await expect(menu(page).getByText("New: gpt-6.2-sol and gpt-6.2-astra.")).toBeVisible();
    await refreshRow(page).click();
    await expect(
      menu(page).getByText(/^Nothing new\. The gateway asked OpenAI again/),
    ).toBeVisible();
    await expect(menu(page).getByRole("menuitemradio", { name: "gpt-6.2-sol" })).toHaveCount(1);
  });

  test("F-588: an answer that comes back after a reconnect to the same gateway is dropped by the screen", async ({
    page,
  }) => {
    await openMenu(page, `${SETTINGS}&refresh=slow`);
    await press(page);
    await expect(refreshRow(page)).toHaveAccessibleDescription("Looking…");
    await page.keyboard.press("Escape");
    // Connected again to the same address, gateway and target: only the time it connected moves.
    await page.evaluate(() =>
      (
        window as unknown as {
          clawtrateFixture: {
            setState: (
              change: (state: { connection: { connectedAt: number | null } }) => unknown,
            ) => void;
          };
        }
      ).clawtrateFixture.setState((state) => ({
        ...state,
        connection: { ...state.connection, connectedAt: (state.connection.connectedAt ?? 0) + 1 },
      })),
    );
    await releaseRefresh(page);
    await page.getByTestId("model-select").click();
    await expect(refreshRow(page)).toHaveAccessibleDescription("Look for new models");
    await expect(menu(page).getByText(/^New: /)).toHaveCount(0);
  });

  test("F-588: while an update of OpenClaw runs, the result points to the note's line about it, not to a version", async ({
    page,
  }) => {
    await openMenu(page, `${SETTINGS}&openclaw=behind&openclawRun=running`);
    await refreshRow(page).click();
    await why(page).click();
    await expect(
      menu(page).getByText(/The note below says where the OpenClaw update stands\./),
    ).toBeVisible();
    await expect(menu(page).getByText(/is out: see the note below/)).toHaveCount(0);
    await expect(page.getByTestId("openclaw-update")).toContainText("OpenClaw is updating");
  });

  test("F-588: the result says only what the note under the menu says: where an update stands, the version again once a run failed, and nothing without a note", async ({
    page,
  }) => {
    // Held: the note says an update may be under way.
    await openMenu(page, `${SETTINGS}&openclaw=behind&openclawRun=held`);
    await refreshRow(page).click();
    await why(page).click();
    await expect(
      menu(page).getByText(/The note below says where the OpenClaw update stands\./),
    ).toBeVisible();
    await expect(page.getByTestId("openclaw-update")).toContainText("may be under way");
    await page.keyboard.press("Escape");
    // Failed: the note names the newer version again, and so does the result.
    await openMenu(page, `${SETTINGS}&openclaw=behind&openclawRun=failed`);
    await refreshRow(page).click();
    await why(page).click();
    await expect(
      menu(page).getByText(/OpenClaw 2026\.11\.6 is out: see the note below\./),
    ).toBeVisible();
    await expect(page.getByTestId("openclaw-update")).toContainText("2026.11.6 is out");
    await page.keyboard.press("Escape");
    // No note: nothing about versions.
    await openMenu(page, SETTINGS);
    await refreshRow(page).click();
    await expect(menu(page).getByText(/^Nothing new\./)).toBeVisible();
    await why(page).click();
    await expect(menu(page).getByText(/note below/)).toHaveCount(0);
    await expect(page.getByTestId("openclaw-update")).toHaveCount(0);
  });
  test("F-588: New bot's Model menu has the same Refresh", async ({ page }) => {
    await openFixture(page, `scene=main&${OTTO_DISK}&access=admin&refresh=new`, "light");
    await page.keyboard.press("ControlOrMeta+n");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("radio", { name: /^OpenAI · Work/ }).click();
    await page.getByTestId("model-select").click();
    await refreshRow(page).click();
    await expect(menu(page).getByText("New: gpt-6.2-sol and gpt-6.2-astra.")).toBeVisible();
    expect(await sent(page)).toHaveLength(1);
  });
});

for (const size of [WIDE, PHONE]) {
  for (const theme of THEMES) {
    test.describe(`model refresh ${size.name} ${theme}`, () => {
      test.use(contextFor(size, theme));

      test("F-588: the Model menu after a Refresh that found new models", async ({ page }) => {
        await openMenu(page, `${SETTINGS}&refresh=slow`, theme);
        await press(page);
        await releaseRefresh(page);
        await expect(menu(page).getByText("New: gpt-6.2-sol and gpt-6.2-astra.")).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`model-refresh-new-${theme}-${size.name}.png`);
      });

      test("F-588: the Model menu after a Refresh that found nothing, with the config's list and a newer OpenClaw", async ({
        page,
      }) => {
        await openMenu(page, `${SETTINGS}&openclaw=behind&allowlist=1`, theme);
        await press(page);
        await expect(menu(page).getByText(/^Nothing new\./)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`model-refresh-nothing-${theme}-${size.name}.png`);
      });

      test("F-588: the Model menu with why nothing new was found open", async ({ page }) => {
        await openMenu(page, `${SETTINGS}&openclaw=behind&allowlist=1`, theme);
        await press(page);
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
        await expect(panel(page)).toBeVisible();
        await settle(page);
        await expect(page).toHaveScreenshot(`model-refresh-why-${theme}-${size.name}.png`);
      });
    });
  }
}
