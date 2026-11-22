// visual-language.md section 5: every creature family in every state at every
// size the app draws avatars at, with the state ring and badge, in dark (the
// default) and light; the fine detail dropped below 21 px; and a still pose
// per state, never a frame from the middle, when motion is reduced.
import { expect, test, type Page } from "@playwright/test";
import { SHEET_SIZES } from "../apps/desktop/src/fixture/avatar-sizes.ts";
import { NOW, THEMES } from "./fixture.ts";

async function openSheet(page: Page, theme: string) {
  await page.clock.setFixedTime(NOW);
  await page.goto(`/?sheet=avatars&theme=${theme}`);
  await page.getByTestId("sheet-cell").first().waitFor();
  await page.evaluate(() => document.fonts.ready);
}

/** Per size: how many fine parts are drawn, and how many there are. */
function fineBySize(page: Page) {
  return page.evaluate(() => {
    const out: Record<string, { shown: number; all: number }> = {};
    for (const cell of document.querySelectorAll<HTMLElement>('[data-testid="sheet-cell"]')) {
      const size = cell.dataset.size!;
      out[size] ??= { shown: 0, all: 0 };
      for (const fine of cell.querySelectorAll(".av-fine")) {
        out[size].all += 1;
        if (getComputedStyle(fine).display !== "none") out[size].shown += 1;
      }
    }
    return out;
  });
}

for (const theme of THEMES)
  test(`every family, state and size, in ${theme}`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 760, height: 1500 },
      deviceScaleFactor: 1,
      colorScheme: theme,
    });
    const page = await context.newPage();
    await openSheet(page, theme);
    // Four creatures (the default Clawling, a chosen Clawling, Shellfolk, a Lantern) × six
    // states × each size, each drawn as a creature and not a picture.
    const cells = page.getByTestId("sheet-cell");
    await expect(cells).toHaveCount(4 * 6 * SHEET_SIZES.length);
    await expect(page.locator('[data-testid="sheet-cell"] svg.creature')).toHaveCount(
      4 * 6 * SHEET_SIZES.length,
    );
    await expect(page.locator('[data-testid="sheet-cell"] img')).toHaveCount(0);
    for (const family of ["clawling", "shellfolk", "lantern"])
      await expect(page.locator(`svg.creature[data-family="${family}"]`).first()).toBeVisible();
    // The ring travels round a working creature; the badge sits on the waiting and blocked ones.
    await expect(page.locator('.presence[data-state="working"]')).toHaveCount(
      4 * SHEET_SIZES.length,
    );
    await expect(page.locator(".presence .glyph")).toHaveCount(2 * 4 * SHEET_SIZES.length);
    const fine = await fineBySize(page);
    expect(fine["18"]!.all).toBeGreaterThan(0);
    expect(fine["18"]!.shown).toBe(0);
    for (const size of [22, 32, 40, 56])
      expect(fine[String(size)]).toEqual({
        shown: fine[String(size)]!.all,
        all: fine[String(size)]!.all,
      });
    await expect(page).toHaveScreenshot(`avatars-sheet-${theme}.png`, { fullPage: true });
    await context.close();
  });

test("with motion reduced, nothing moves and each state holds its still pose", async ({
  browser,
}) => {
  const moving = await browser.newContext({ viewport: { width: 760, height: 1500 } });
  const page = await moving.newPage();
  await openSheet(page, "dark");
  const animations = (p: Page) =>
    p.evaluate(() =>
      [...document.querySelectorAll("svg.creature *")]
        .map((each) => getComputedStyle(each).animationName)
        .filter((name) => name !== "none"),
    );
  const waving = '[data-state="waiting"] svg[data-family="clawling"] .av-still';
  // With motion: the creatures play their motions, the waving claw among them.
  const played = new Set(await animations(page));
  for (const name of [
    "av-blink",
    "av-sway",
    "av-snap",
    "av-wave",
    "av-hop",
    "av-crawl",
    "av-tilt",
    "av-conduct",
    "av-ping",
  ])
    expect(played).toContain(name);
  await moving.close();

  const reduced = await browser.newContext({
    viewport: { width: 760, height: 1500 },
    reducedMotion: "reduce",
  });
  const still = await reduced.newPage();
  await openSheet(still, "dark");
  expect(await animations(still)).toEqual([]);
  // The waving claw is raised, not left at rest or mid-wave.
  const raised = await still
    .locator(waving)
    .evaluateAll((arms) => arms.map((arm) => getComputedStyle(arm).rotate));
  expect(raised.length).toBeGreaterThan(0);
  expect(new Set(raised)).toEqual(new Set(["-54deg"]));
  await reduced.close();
});
