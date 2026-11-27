// Parity rows for the tasks under each bot.
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;

const bot = (page: Page, name: string) =>
  page.getByTestId("bot-list").getByRole("button", { name: new RegExp(`^${name}\\b`) });

const tasksOf = (page: Page, name: string) =>
  page.getByRole("list", { name: `${name}'s tasks` }).getByTestId("task");

test.use(contextFor(WIDE, "light"));

test("F-425: a bot's disclosure shows its tasks with title, status and time, and stays as it was left after a restart", async ({
  page,
}) => {
  await openFixture(page, `scene=main&${OTTO_DISK}`, "light");
  const otto = tasksOf(page, "Otto");
  await expect(otto).toHaveCount(6);
  // Title, time of last activity, and a status mark where there is one.
  await expect(otto.locator(".task-title")).toHaveText([
    "Rotate the logs on every machine in the rack before the disks fill up again",
    "Disk almost full on the media box",
    "Weekly backup check",
    "Certificate renewal warning",
    "Router firmware",
    "Printer offline again",
  ]);
  await expect(otto.locator(".task-time")).toHaveText([
    "now",
    "5:36 PM",
    "2:34 PM",
    "Yesterday",
    "Sat",
    "Fri",
  ]);
  await expect(otto.nth(0).locator(".glyph")).toHaveAttribute("data-state", "working");
  await expect(otto.nth(0)).toHaveAccessibleName(/, working$/);
  await expect(otto.nth(0)).toHaveAccessibleDescription("Last activity now");
  await expect(otto.nth(2).locator(".unread-dot")).toHaveCount(1);
  await expect(otto.nth(4)).toHaveAccessibleDescription("Last activity Sat");
  await page.getByRole("button", { name: "Show all 14" }).click();
  await expect(otto).toHaveCount(14);
  await expect(otto.nth(13).locator(".task-time")).toHaveText("Oct 28");

  // Fold Otto (the open bot) and unfold Pip, both by hand; a restart keeps both. Otto's row opens
  // its main conversation, so Left on it folds it.
  await bot(page, "Otto").focus();
  await page.keyboard.press("ArrowLeft");
  await expect(bot(page, "Otto")).toHaveAttribute("aria-expanded", "false");
  await bot(page, "Pip").focus();
  await page.keyboard.press("ArrowRight");
  await expect(bot(page, "Pip")).toHaveAttribute("aria-expanded", "true");
  await page.reload();
  await expect(bot(page, "Otto")).toHaveAttribute("aria-expanded", "false");
  await expect(bot(page, "Pip")).toHaveAttribute("aria-expanded", "true");
  await expect(tasksOf(page, "Pip").locator(".task-title")).toHaveText([
    "Plan the week",
    "Trip to the coast in March",
    "Birthday dinner",
    "Reading list for the spring",
  ]);
  await expect(tasksOf(page, "Pip").nth(1).locator(".glyph")).toHaveAttribute(
    "data-state",
    "failed",
  );
  await expect(tasksOf(page, "Otto")).toHaveCount(0);
  // And unfolding Otto again, by opening it, is remembered too.
  await bot(page, "Otto").click();
  await page.reload();
  await expect(bot(page, "Otto")).toHaveAttribute("aria-expanded", "true");
});

test("F-057: each task row shows its own state as a mark", async ({ page }) => {
  await openFixture(page, "scene=task-states&bot=pip", "light");
  const mark = async (name: string, title: string) => {
    if ((await bot(page, name).getAttribute("aria-expanded")) === "false") {
      await bot(page, name).focus();
      await page.keyboard.press("ArrowRight");
    }
    const row = tasksOf(page, name).filter({ hasText: title });
    const glyph = row.locator(".task-mark .glyph");
    return {
      mark: (await glyph.count()) ? await glyph.getAttribute("data-state") : null,
      dot: await row.locator(".unread-dot").count(),
      name: (await row.getAttribute("aria-label"))!,
    };
  };
  expect(await mark("Juniper", "Heat pump")).toEqual({
    mark: "waiting",
    dot: 0,
    name: "Heat pump vs. gas furnace, needs you",
  });
  expect(await mark("Juniper", "Library e-book")).toMatchObject({ mark: "working" });
  expect(await mark("Pip", "Trip to the coast")).toMatchObject({
    mark: "failed",
    name: "Trip to the coast in March, last run failed",
  });
  expect(await mark("Otto", "Weekly backup check")).toMatchObject({
    mark: "failed",
    name: "Weekly backup check, done with failures",
  });
  expect(await mark("Otto", "Certificate renewal")).toEqual({
    mark: null,
    dot: 0,
    name: "Certificate renewal warning",
  });
  // Marlow has one task, so its blocked state is on its row's avatar.
  await expect(bot(page, "Marlow").locator(".presence > .glyph")).toHaveAttribute(
    "data-state",
    "blocked",
  );
});
