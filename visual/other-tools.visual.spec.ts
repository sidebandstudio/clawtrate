// What other tools started with a bot stays out of its task list by default
// (docs/parity.md F-563). In the fixture that is a routine's latest run, which
// is a row under its bot only with "Show sessions from other tools" on; the
// routine's page opens it either way. Sessions the gateway lists, an API
// client's or a scheduled custom session, are checked through the client
// (packages/core/test/origins.test.ts) and against a development gateway
// (e2e/other-tools.spec.ts).
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, SIZES } from "./fixture.ts";

const runRows = (page: Page, bot: string) =>
  page
    .locator(".bot-group")
    .filter({ has: page.getByTestId("bot").getByText(bot, { exact: true }) })
    .getByTestId("routine-task");

test.use(contextFor(SIZES[0]!));

test("F-563: a routine's runs are not rows under its bot until Show sessions from other tools is on, which lists them at once, except a failed one; Routines opens them either way", async ({
  page,
}) => {
  await openFixture(page, "scene=main&routines=on", "light");
  await expect(page.getByTestId("bot").first()).toBeVisible();
  // Otto's and Marlow's routines ran in the last day. By default the rail lists only a run that
  // failed, which the person needs to know about, and it opens that run.
  await expect(runRows(page, "Otto")).toHaveCount(1);
  await expect(runRows(page, "Otto")).toHaveAttribute("data-state", "failed");
  await expect(runRows(page, "Otto")).toHaveAccessibleName(
    "Nightly backup check, routine run, failed",
  );
  await expect(runRows(page, "Marlow")).toHaveCount(0);
  await runRows(page, "Otto").click();
  await expect(
    page.getByTestId("routines-view").getByRole("heading", { name: "Nightly backup check" }),
  ).toBeVisible();
  // Routines still opens a run.
  await page.getByRole("button", { name: "Routines", exact: true }).click();
  const view = page.getByTestId("routines-view");
  await expect(view).toBeVisible();
  await view
    .getByRole("button", { name: /Morning digest/ })
    .first()
    .click();
  await expect(view.getByRole("heading", { name: "Morning digest" })).toBeVisible();
  // The switch lists them at once, with nothing read again.
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  const others = settings.getByRole("switch", { name: "Show sessions from other tools" });
  await expect(others).toHaveAttribute("aria-checked", "false");
  await others.click();
  await expect(others).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await expect(runRows(page, "Otto")).toHaveCount(2);
  await expect(runRows(page, "Marlow")).toHaveCount(1);
});

test("F-563: the Archived group lists another tool's archived session once the switch is on, and leaves it out again when off", async ({
  page,
}) => {
  await openFixture(page, "scene=rail-write&bot=otto", "light");
  await page.getByRole("button", { name: "Archived" }).click();
  const archived = page.getByRole("list", { name: "Otto's archived tasks" });
  await expect(archived.getByTestId("archived-task")).toHaveCount(2);
  const toggle = async (to: "true" | "false") => {
    await page.keyboard.press("ControlOrMeta+,");
    const settings = page.getByRole("dialog", { name: "Settings" });
    await settings.getByRole("button", { name: "Advanced", exact: true }).click();
    const others = settings.getByRole("switch", { name: "Show sessions from other tools" });
    await others.click();
    await expect(others).toHaveAttribute("aria-checked", to);
    await page.keyboard.press("Escape");
  };
  // The open group reads the list again when the switch changes.
  await toggle("true");
  await expect(archived.getByTestId("archived-task")).toHaveCount(3);
  await expect(
    archived.getByTestId("archived-task").filter({ hasText: "Backup script report" }),
  ).toBeVisible();
  await toggle("false");
  await expect(archived.getByTestId("archived-task")).toHaveCount(2);
});

type Fixture = { setState(change: (state: ClawtrateState) => ClawtrateState): void };

const searchHit = async (page: Page, query: string, text: string) => {
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("search-palette");
  await palette.getByRole("combobox").fill(query);
  const hit = palette
    .getByTestId("search-group-messages")
    .getByRole("option")
    .filter({ hasText: text });
  await expect(hit).toBeVisible();
  return { palette, hit };
};

test("F-563: a message found in a task the list doesn't hold opens in its own conversation", async ({
  page,
}) => {
  await openFixture(
    page,
    "scene=main&bot=otto&task=agent:otto:disk-space&search=on&src=unlisted",
    "light",
  );
  const { palette, hit } = await searchHit(page, "transcode", "Old transcode settings");
  await hit.click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".turn[data-search-focus]")).toContainText(
    "The transcode settings from last year are in the old notes folder.",
  );
});

test("F-563: a message found before its task left the list still opens in its own conversation", async ({
  page,
}) => {
  await openFixture(page, "scene=main&bot=pip&task=agent:pip:week&search=on", "light");
  const { palette, hit } = await searchHit(
    page,
    "clear the transcode",
    "Yes, clear the transcode cache.",
  );
  // Its task leaves the list, as turning a switch off can make it, while the result is shown.
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      tasksByBot: {
        ...state.tasksByBot,
        otto: (state.tasksByBot.otto ?? []).filter((task) => task.key !== "agent:otto:disk-space"),
      },
    }));
  });
  await hit.click();
  await expect(palette).toHaveCount(0);
  await expect(page.locator(".turn[data-search-focus]")).toContainText(
    "Yes, clear the transcode cache.",
  );
});
