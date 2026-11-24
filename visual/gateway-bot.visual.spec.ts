// The gateway's own bot (F-562) in the fixture mode. Juniper is the fixture gateway's default
// bot. The fixture keeps "Show the gateway's own bot" on so the other scenes keep Juniper in the
// rail; `gatewaybot=off` is the default a person starts with. The rule itself is unit-tested in
// packages/core/test/gateway-bot.test.ts, and e2e/gateway-bot.spec.ts checks it on a gateway.
import { test, type Page } from "@playwright/test";
import {
  contextFor,
  expect,
  hold,
  openFixture,
  OTTO_DISK,
  paintedFinal,
  release,
  showList,
  SIZES,
} from "./fixture.ts";

const SHOWN = SIZES.filter((size) => size.name === "1440" || size.name === "phone");
const WIDE = SHOWN[0]!;

const rail = (page: Page) => page.getByTestId("bot-list");
const railBot = (page: Page, name: string) =>
  rail(page).getByRole("button", { name: new RegExp(`^${name}\\b`) });

async function setState(page: Page, change: string): Promise<void> {
  await page.evaluate((body) => {
    const fixture = (
      window as unknown as {
        clawtrateFixture: { setState(change: (state: unknown) => unknown): void };
      }
    ).clawtrateFixture;
    fixture.setState(new Function("state", `return (${body})(state);`) as (s: unknown) => unknown);
  }, change);
}

/** Only the gateway's own bot, as on a gateway where nobody has made another. */
const ONLY_ITS_OWN = `(state) => ({ ...state, bots: state.bots.filter((bot) => bot.isDefault) })`;

/** Juniper's heat-pump task waiting on the person, or done again. */
const heatPump = (status: "waiting" | "done") =>
  `(state) => ({ ...state, tasksByBot: { ...state.tasksByBot, main: state.tasksByBot.main.map((task) => task.key === "agent:main:heat-pump" ? { ...task, status: "${status}", waitingFor: ${status === "waiting" ? '"question"' : "undefined"}, waitingSince: ${status === "waiting" ? "Date.now()" : "undefined"} } : task) } })`;

async function advanced(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  return settings;
}

test.describe("the gateway's own bot", () => {
  test.use(contextFor(WIDE, "light"));

  test("F-562: with another bot, the gateway's own bot is not in the rail, Hidden bots, the rail's search or the search palette, and no bot is starred", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&hidden=marlow&gatewaybot=off`, "light");
    await expect(railBot(page, "Otto")).toBeVisible();
    await expect(railBot(page, "Juniper")).toHaveCount(0);
    await expect(rail(page).getByTestId("primary-star")).toHaveCount(0);
    await page.getByRole("button", { name: /^Hidden bots/ }).click();
    const hidden = page.getByRole("list", { name: "Hidden bots" });
    await expect(hidden.getByRole("button", { name: /^Marlow\b/ })).toBeVisible();
    await expect(hidden.getByRole("button", { name: /^Juniper\b/ })).toHaveCount(0);
    // The rail's own search.
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await page.getByRole("textbox", { name: "Search bots" }).fill("u");
    await expect(railBot(page, "Quartermaster")).toBeVisible();
    await expect(railBot(page, "Juniper")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // The search palette lists no bot row for it.
    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByTestId("search-palette");
    await palette.getByRole("combobox", { name: "Search" }).fill("u");
    const bots = palette.getByTestId("search-group-bots").getByRole("option");
    await expect(bots.filter({ hasText: "Quartermaster" })).toHaveCount(1);
    await expect(bots.filter({ hasText: "Juniper" })).toHaveCount(0);
    // Nor its tasks by title.
    await palette.getByRole("combobox", { name: "Search" }).fill("Heat pump");
    await expect(palette.getByTestId("search-group-tasks").getByRole("option")).toHaveCount(0);
    // Nor its workspace's files: the others' are searched, and its notes/heat-pumps.md is not.
    const files = palette.getByTestId("search-group-files");
    await expect(files).toContainText("No file names returned from Otto");
    await expect(files).not.toContainText("Juniper");
    await expect(files).not.toContainText("heat-pumps");
  });

  test("F-562: the dock badge counts no unread task of the gateway's own bot while it is out of view", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await expect(railBot(page, "Otto")).toBeVisible();
    const badge = () =>
      page.evaluate(
        () =>
          (window as unknown as { clawtrateFixture: { badge: number | null } }).clawtrateFixture
            .badge,
      );
    const itsUnread = await page.evaluate(
      () =>
        (
          window as unknown as {
            clawtrateFixture: {
              getState(): { tasksByBot: Record<string, Array<{ unread: boolean }>> };
            };
          }
        ).clawtrateFixture
          .getState()
          .tasksByBot.main!.filter((task) => task.unread).length,
    );
    expect(itsUnread, "the fixture's Juniper has unread tasks").toBeGreaterThan(0);
    await expect.poll(badge).not.toBeNull();
    const hidden = (await badge())!;
    await setState(page, `(state) => ({ ...state, showGatewayBot: true })`);
    await expect.poll(badge).toBe(hidden + itsUnread);
  });

  test("F-562: the gateway's own bot opened while it waited stays open, and in the rail, after its wait ends, until another bot is opened", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await setState(page, heatPump("waiting"));
    await railBot(page, "Juniper").click();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(page.getByTestId("transcript")).toContainText("installer");
    const opened = await heading.textContent();
    await setState(page, heatPump("done"));
    await expect(railBot(page, "Juniper")).not.toHaveAccessibleName(/waiting for you/);
    await expect(railBot(page, "Juniper")).toBeVisible();
    await expect(heading).toHaveText(opened!);
    await expect(page.getByTestId("transcript")).toContainText("installer");
    // Another bot opened: it leaves.
    await railBot(page, "Pip").click();
    await expect(railBot(page, "Juniper")).toHaveCount(0);
  });

  test("F-562: the gateway's own bot open while it waits stays open, and in the rail, when the switch is turned off, until another bot is opened", async ({
    page,
  }) => {
    await openFixture(page, `bot=main&task=agent:main:heat-pump&panel=closed`, "light");
    await setState(page, heatPump("waiting"));
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(/Heat pump/);
    const settings = await advanced(page);
    await settings.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(heading).toHaveText(/Heat pump/);
    await expect(railBot(page, "Juniper")).toBeVisible();
    // Its wait ends: still open, still listed.
    await setState(page, heatPump("done"));
    await expect(railBot(page, "Juniper")).not.toHaveAccessibleName(/waiting for you/);
    await expect(heading).toHaveText(/Heat pump/);
    await expect(railBot(page, "Juniper")).toBeVisible();
    await railBot(page, "Pip").click();
    await expect(railBot(page, "Juniper")).toHaveCount(0);
    await expect(heading).not.toHaveText(/Heat pump/);
  });

  test("F-562: the palette's file results follow the bots the sidebar lists while it stays open", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on`, "light");
    await setState(page, heatPump("waiting"));
    await expect(railBot(page, "Juniper")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByTestId("search-palette");
    await palette.getByRole("combobox", { name: "Search" }).fill("heat-pumps");
    const files = palette.getByTestId("search-group-files");
    await expect(files.getByRole("option").filter({ hasText: "heat-pumps.md" })).toHaveCount(1);
    // Answered: Juniper leaves the sidebar, and its file result, coverage and retries go with it.
    await setState(page, heatPump("done"));
    await expect(railBot(page, "Juniper")).toHaveCount(0);
    await expect(files.getByRole("option").filter({ hasText: "heat-pumps.md" })).toHaveCount(0);
    await expect(files).not.toContainText("Juniper");
  });

  test("F-562: Search each bot for more keeps a message already found in a task of the gateway's own bot", async ({
    page,
  }) => {
    await openFixture(
      page,
      `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on&src=truncated`,
      "light",
    );
    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByTestId("search-palette");
    await palette.getByRole("combobox", { name: "Search" }).fill("coffee");
    const messages = palette.getByTestId("search-group-messages");
    const found = messages.getByRole("option").filter({ hasText: "Caffeine cutoff time" });
    await expect(found).toHaveCount(1);
    await messages.getByRole("option", { name: "Search each bot for more" }).click();
    await expect(messages).toContainText("bots answered");
    await expect(found).toHaveCount(1);
  });

  test("F-562: a saved open bot out of view gives way for good, and the gateway's own bot starting to wait never takes the conversation", async ({
    page,
  }) => {
    await openFixture(
      page,
      `bot=main&task=agent:main:heat-pump&panel=closed&gatewaybot=off`,
      "light",
    );
    const heading = page.getByRole("heading", { level: 1 });
    await expect(railBot(page, "Marlow")).toBeVisible();
    await expect(heading).not.toHaveText(/Heat pump/);
    const opened = await heading.textContent();
    // The bot opened in its place is now the saved one.
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.bot"))).toBe("marlow");
    await setState(
      page,
      `(state) => ({ ...state, tasksByBot: { ...state.tasksByBot, main: state.tasksByBot.main.map((task) => task.key === "agent:main:heat-pump" ? { ...task, status: "waiting", waitingFor: "question", waitingSince: Date.now() } : task) } })`,
    );
    await expect(railBot(page, "Juniper")).toHaveAccessibleName(/waiting for you/);
    await expect(heading).toHaveText(opened!);
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.bot"))).toBe("marlow");
    // Picked by the person, it opens.
    await railBot(page, "Juniper").click();
    await expect(page.getByTestId("transcript")).toContainText("installer");
  });

  test("F-562: a routine of the gateway's own bot made again as new keeps that bot in the editor's list", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&routines=on&access=admin&gatewaybot=off`, "light");
    // Plan the week, made the gateway's own bot's for this check.
    await setState(
      page,
      `(state) => ({ ...state, routines: { ...state.routines, routines: state.routines.routines.map((each) => each.id === "routine-week" ? { ...each, botId: "main" } : each) } })`,
    );
    const back = page.getByRole("button", { name: "Back to bots" });
    if (await back.isVisible().catch(() => false)) await back.click();
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    const view = page.getByTestId("routines-view");
    await view
      .getByTestId("routine-row")
      .filter({ hasText: "Plan the week" })
      .locator(".r-row-main")
      .click();
    await view.getByTestId("routine-actions").getByRole("button", { name: "Edit" }).click();
    const editor = page.getByTestId("routine-editor");
    await expect(editor.getByRole("heading", { name: "Edit routine" })).toBeVisible();
    // Deleted elsewhere while it is edited.
    await setState(
      page,
      `(state) => ({ ...state, routines: { ...state.routines, routines: state.routines.routines.filter((each) => each.id !== "routine-week"), removed: { id: "routine-week", ranOnce: false, runAt: null } } })`,
    );
    await hold(page);
    await editor.getByRole("button", { name: "Save as a new routine" }).click();
    const select = editor.getByLabel("Bot");
    await expect(select).toHaveValue("main");
    await expect(select.locator("option:checked")).toHaveText("Juniper");
    await release(page);
  });

  test("F-562: Settings → Advanced has Show the gateway's own bot, off by default; on, Juniper is back and starred, and the choice reaches the host", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    const settings = await advanced(page);
    const toggle = settings.getByRole("switch", { name: "Show the gateway's own bot" });
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(toggle).toHaveAccessibleDescription(/scheduled runs that name no bot land on it/);
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                clawtrateFixture: { getState(): { showGatewayBot?: boolean } };
              }
            ).clawtrateFixture.getState().showGatewayBot,
        ),
      )
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(railBot(page, "Juniper")).toBeVisible();
    await expect(railBot(page, "Juniper")).toHaveAccessibleName(/, primary bot/);
    await expect(railBot(page, "Juniper").getByTestId("primary-star")).toHaveCount(1);
    await advanced(page);
    await page.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(railBot(page, "Juniper")).toHaveCount(0);
  });

  test("F-562: the only bot on the gateway shows, starred, as before", async ({ page }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await setState(page, ONLY_ITS_OWN);
    await expect(railBot(page, "Juniper")).toHaveAccessibleName(/, primary bot/);
    await expect(rail(page).getByTestId("bot")).toHaveCount(1);
  });

  test("F-562: while one of its tasks waits on the person it shows, and leaves once answered", async ({
    page,
  }) => {
    await openFixture(page, `scene=task-states&${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await expect(railBot(page, "Juniper")).toHaveAccessibleName(/waiting for you/);
    await setState(
      page,
      `(state) => ({ ...state, tasksByBot: { ...state.tasksByBot, main: state.tasksByBot.main.map((task) => task.status === "waiting" ? { ...task, status: "done", waitingFor: undefined, waitingSince: undefined } : task) } })`,
    );
    await expect(railBot(page, "Juniper")).toHaveCount(0);
    await expect(railBot(page, "Otto")).toBeVisible();
  });

  test("F-562: the open bot gives way when it leaves the rail, and a link to one of its tasks still opens that task, listed until another bot is opened", async ({
    page,
  }) => {
    await openFixture(page, `bot=main&task=agent:main:heat-pump&panel=closed&search=on`, "light");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText(/Heat pump/);
    const settings = await advanced(page);
    await settings.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(railBot(page, "Juniper")).toHaveCount(0);
    // Another bot opens: the first the rail lists.
    await expect(heading).not.toHaveText(/Heat pump/);
    // A message found in one of its tasks opens that task. Opened, the bot is in the rail until
    // another is opened.
    await page.keyboard.press("ControlOrMeta+K");
    const palette = page.getByTestId("search-palette");
    await palette.getByRole("combobox", { name: "Search" }).fill("coffee");
    await palette.getByTestId("search-group-messages").getByRole("option").first().click();
    await expect(heading).toHaveText("Caffeine cutoff time");
    await expect(railBot(page, "Juniper")).toBeVisible();
    await railBot(page, "Pip").click();
    await expect(railBot(page, "Juniper")).toHaveCount(0);
  });
});

for (const size of SHOWN) {
  test.describe(`${size.name}`, () => {
    test.use(contextFor(size));

    test(`F-562: the rail without the gateway's own bot, at ${size.name}`, async ({ page }) => {
      await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`);
      await showList(page);
      await expect(railBot(page, "Otto")).toBeVisible();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`gateway-bot-hidden-${size.name}.png`);
    });

    test(`F-562: the gateway's own bot as the only bot, at ${size.name}`, async ({ page }) => {
      await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`);
      await setState(page, ONLY_ITS_OWN);
      await showList(page);
      await expect(rail(page).getByTestId("bot")).toHaveCount(1);
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`gateway-bot-only-${size.name}.png`);
    });

    test(`F-562: the gateway's own bot while it waits on you, at ${size.name}`, async ({
      page,
    }) => {
      await openFixture(page, `scene=task-states&${OTTO_DISK}&panel=closed&gatewaybot=off`);
      await showList(page);
      await expect(railBot(page, "Juniper")).toHaveAccessibleName(/waiting for you/);
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`gateway-bot-waiting-${size.name}.png`);
    });

    test(`F-562: Settings → Advanced with Show the gateway's own bot, at ${size.name}`, async ({
      page,
    }) => {
      await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`);
      const settings = await advanced(page);
      await expect(
        settings.getByRole("switch", { name: "Show the gateway's own bot" }),
      ).toBeVisible();
      await paintedFinal(page);
      await expect(page).toHaveScreenshot(`gateway-bot-setting-${size.name}.png`);
    });
  });
}
