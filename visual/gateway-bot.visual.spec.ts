// The gateway's own bot (F-562) in the fixture mode. The fixture gateway's default bot is `main`,
// named "main", with no picture and one main conversation, fed by a channel; Juniper is the Main
// Bot, the bot Clawtrate made (`clawtrate-main-bot`). The fixture starts with "Show the gateway's
// own bot" off, as a person does; `gatewaybot=on` turns it on. The rule itself is unit-tested in
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

/** The gateway's own bot's main conversation, and the words of its one exchange. */
const OWN_MAIN = "agent:main:main";
const OWN_WORDS = "porch light";

/** Its main conversation waiting on the person, or done again. */
const ownWait = (status: "waiting" | "done") =>
  `(state) => ({ ...state, tasksByBot: { ...state.tasksByBot, main: state.tasksByBot.main.map((task) => task.key === "${OWN_MAIN}" ? { ...task, status: "${status}", waitingFor: ${status === "waiting" ? '"question"' : "undefined"}, waitingSince: ${status === "waiting" ? "Date.now()" : "undefined"} } : task) } })`;

/** A second task of the gateway's own bot, for this check only: a copy of its main conversation. */
const SECOND_OWN = `(state) => ({ ...state, tasksByBot: { ...state.tasksByBot, main: [...state.tasksByBot.main, { ...state.tasksByBot.main[0], key: "agent:main:hallway", sessionId: "main-hallway", title: "Hallway motion sensor", unread: false, updatedAt: state.tasksByBot.main[0].updatedAt - 60000 }] }, transcripts: { ...state.transcripts, "agent:main:hallway": { ...state.transcripts["${OWN_MAIN}"], sessionKey: "agent:main:hallway" } } })`;

/** The search palette's results for `query`. */
async function palette(page: Page, query: string) {
  await page.keyboard.press("ControlOrMeta+K");
  const found = page.getByTestId("search-palette");
  await found.getByRole("combobox", { name: "Search" }).fill(query);
  return found;
}

async function advanced(page: Page) {
  await page.keyboard.press("ControlOrMeta+,");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("button", { name: "Advanced", exact: true }).click();
  return settings;
}

test.describe("the gateway's own bot", () => {
  test.use(contextFor(WIDE, "light"));

  test("the fixture's Main Bot is a bot Clawtrate made, listed beside the gateway's own bot, which is out of view", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed`, "light");
    type Shape = {
      bots: Array<{ id: string; name: string; isDefault: boolean; avatarUrl: string | null }>;
      tasksByBot: Record<string, Array<{ key: string }>>;
    };
    const state = await page.evaluate(
      () =>
        (
          window as unknown as { clawtrateFixture: { getState(): Shape } }
        ).clawtrateFixture.getState() as Shape,
    );
    // The gateway's own bot: its default, named "main", with no picture and one main conversation.
    const own = state.bots.filter((bot) => bot.isDefault);
    expect(own.map(({ id, name, avatarUrl }) => ({ id, name, avatarUrl }))).toEqual([
      { id: "main", name: "main", avatarUrl: null },
    ]);
    expect(state.tasksByBot.main!.map((task) => task.key)).toEqual(["agent:main:main"]);
    // Juniper is the bot Clawtrate's first run makes, by its id, and not the gateway's default.
    const juniper = state.bots.find((bot) => bot.name === "Juniper")!;
    expect(juniper.id).toBe("clawtrate-main-bot");
    expect(juniper.isDefault).toBe(false);
    expect(juniper.avatarUrl).not.toBeNull();
    expect(state.tasksByBot["clawtrate-main-bot"]!.length).toBeGreaterThan(0);
    // Off, as a person starts: Juniper listed, the gateway's own bot not, and no bot starred.
    await expect(railBot(page, "Juniper")).toBeVisible();
    await expect(railBot(page, "main")).toHaveCount(0);
    await expect(rail(page).getByTestId("primary-star")).toHaveCount(0);
    // On: both listed; the star is still the gateway's default's, until the Main Bot has its own.
    await setState(page, `(state) => ({ ...state, showGatewayBot: true })`);
    await expect(railBot(page, "main").getByTestId("primary-star")).toHaveCount(1);
    await expect(railBot(page, "Juniper")).toBeVisible();
    await expect(railBot(page, "Juniper").getByTestId("primary-star")).toHaveCount(0);
  });

  test("F-562: with another bot, the gateway's own bot is not in the rail, Hidden bots, the rail's search or the search palette, and no bot is starred", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&hidden=marlow&gatewaybot=off`, "light");
    await expect(railBot(page, "Otto")).toBeVisible();
    // Juniper, the Main Bot, is listed; the gateway's own bot is not.
    await expect(railBot(page, "Juniper")).toBeVisible();
    await expect(railBot(page, "main")).toHaveCount(0);
    await expect(rail(page).getByTestId("primary-star")).toHaveCount(0);
    await page.getByRole("button", { name: /^Hidden bots/ }).click();
    const hidden = page.getByRole("list", { name: "Hidden bots" });
    await expect(hidden.getByRole("button", { name: /^Marlow\b/ })).toBeVisible();
    await expect(hidden.getByRole("button", { name: /^main\b/ })).toHaveCount(0);
    // The rail's own search.
    await page.keyboard.press("ControlOrMeta+Shift+F");
    await page.getByRole("textbox", { name: "Search bots" }).fill("a");
    await expect(railBot(page, "Quartermaster")).toBeVisible();
    await expect(railBot(page, "main")).toHaveCount(0);
    await page.keyboard.press("Escape");
    // The search palette lists no bot row for it.
    const found = await palette(page, "a");
    const bots = found.getByTestId("search-group-bots");
    await expect(bots.getByRole("option").filter({ hasText: "Quartermaster" })).toHaveCount(1);
    await expect(bots.getByRole("option", { name: /^main\b/ })).toHaveCount(0);
    // Nor its main conversation by title: Marlow's is the only "Main".
    await found.getByRole("combobox", { name: "Search" }).fill("Main");
    await expect(found.getByTestId("search-group-tasks").getByRole("option")).toHaveCount(1);
    // Nor its workspace's files: the others' are searched, and its notes/porch-light.md is not.
    await found.getByRole("combobox", { name: "Search" }).fill("porch");
    const files = found.getByTestId("search-group-files");
    // Five bots' workspaces: every bot but the gateway's own.
    await expect(files).toContainText("4 of 5 bots' workspaces searched.");
    await expect(files).not.toContainText(/\bmain\b/);
    await expect(files).not.toContainText("porch-light");
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
    expect(itsUnread, "the fixture's gateway's own bot has an unread task").toBeGreaterThan(0);
    await expect.poll(badge).not.toBeNull();
    const hidden = (await badge())!;
    await setState(page, `(state) => ({ ...state, showGatewayBot: true })`);
    await expect.poll(badge).toBe(hidden + itsUnread);
  });

  test("F-562: the gateway's own bot opened while it waited stays open, and in the rail, after its wait ends, until another bot is opened", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await setState(page, ownWait("waiting"));
    await railBot(page, "main").click();
    const heading = page.getByRole("heading", { level: 1 });
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
    const opened = await heading.textContent();
    await setState(page, ownWait("done"));
    await expect(railBot(page, "main")).not.toHaveAccessibleName(/waiting for you/);
    await expect(railBot(page, "main")).toBeVisible();
    await expect(heading).toHaveText(opened!);
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
    // Another bot opened: it leaves.
    await railBot(page, "Pip").click();
    await expect(railBot(page, "main")).toHaveCount(0);
  });

  test("F-562: the gateway's own bot open while it waits stays open, and in the rail, when the switch is turned off, until another bot is opened", async ({
    page,
  }) => {
    await openFixture(page, `bot=main&task=${OWN_MAIN}&panel=closed&gatewaybot=on`, "light");
    await setState(page, ownWait("waiting"));
    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toHaveText("Main");
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
    const settings = await advanced(page);
    await settings.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
    await expect(railBot(page, "main")).toBeVisible();
    // Its wait ends: still open, still listed.
    await setState(page, ownWait("done"));
    await expect(railBot(page, "main")).not.toHaveAccessibleName(/waiting for you/);
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
    await expect(railBot(page, "main")).toBeVisible();
    await railBot(page, "Pip").click();
    await expect(railBot(page, "main")).toHaveCount(0);
    await expect(page.getByTestId("transcript")).not.toContainText(OWN_WORDS);
  });

  test("F-562: the palette's file results follow the bots the sidebar lists while it stays open", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on`, "light");
    await setState(page, ownWait("waiting"));
    await expect(railBot(page, "main")).toBeVisible();
    const found = await palette(page, "porch-light");
    const files = found.getByTestId("search-group-files");
    await expect(files.getByRole("option").filter({ hasText: "porch-light.md" })).toHaveCount(1);
    // Answered: it leaves the sidebar, and its file result, coverage and retries go with it.
    await setState(page, ownWait("done"));
    await expect(railBot(page, "main")).toHaveCount(0);
    await expect(files.getByRole("option").filter({ hasText: "porch-light.md" })).toHaveCount(0);
    await expect(files).not.toContainText(/\bmain\b/);
  });

  test("F-562: Search each bot for more keeps a message already found in a task of the gateway's own bot", async ({
    page,
  }) => {
    await openFixture(
      page,
      `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on&src=truncated`,
      "light",
    );
    // Its answer, the one message that says "sunset".
    const messages = (await palette(page, "sunset")).getByTestId("search-group-messages");
    const found = messages.getByRole("option").filter({ hasText: "sunset" });
    await expect(found).toHaveCount(1);
    await messages.getByRole("option", { name: "Search each bot for more" }).click();
    await expect(messages).toContainText("bots answered");
    await expect(found).toHaveCount(1);
  });

  test("F-562: a saved open bot out of view gives way for good, and the gateway's own bot starting to wait never takes the conversation", async ({
    page,
  }) => {
    await openFixture(page, `bot=main&task=${OWN_MAIN}&panel=closed&gatewaybot=off`, "light");
    const heading = page.getByRole("heading", { level: 1 });
    await expect(railBot(page, "Marlow")).toBeVisible();
    await expect(page.getByTestId("transcript")).not.toContainText(OWN_WORDS);
    const opened = await heading.textContent();
    // The bot opened in its place, the first the rail lists, is now the saved one.
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.bot"))).toBe(
      "clawtrate-main-bot",
    );
    await setState(page, ownWait("waiting"));
    await expect(railBot(page, "main")).toHaveAccessibleName(/waiting for you/);
    await expect(heading).toHaveText(opened!);
    expect(await page.evaluate(() => localStorage.getItem("clawtrate.bot"))).toBe(
      "clawtrate-main-bot",
    );
    // Picked by the person, it opens.
    await railBot(page, "main").click();
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
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
    await expect(select.locator("option:checked")).toHaveText("main");
    await release(page);
  });

  test("F-562: Settings → Advanced has Show the gateway's own bot, off by default; on, the gateway's own bot is back and starred, and the choice reaches the host", async ({
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
    await expect(railBot(page, "main")).toBeVisible();
    await expect(railBot(page, "main")).toHaveAccessibleName(/, primary bot/);
    await expect(railBot(page, "main").getByTestId("primary-star")).toHaveCount(1);
    // The Main Bot, which Clawtrate made, is an ordinary row beside it.
    await expect(railBot(page, "Juniper").getByTestId("primary-star")).toHaveCount(0);
    await advanced(page);
    await page.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(railBot(page, "main")).toHaveCount(0);
  });

  test("F-562: the only bot on the gateway shows, starred, as before", async ({ page }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await setState(page, ONLY_ITS_OWN);
    await expect(railBot(page, "main")).toHaveAccessibleName(/, primary bot/);
    await expect(rail(page).getByTestId("bot")).toHaveCount(1);
  });

  test("F-562: while one of its tasks waits on the person it shows, and leaves once answered", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`, "light");
    await expect(railBot(page, "main")).toHaveCount(0);
    await setState(page, ownWait("waiting"));
    await expect(railBot(page, "main")).toHaveAccessibleName(/waiting for you/);
    await setState(page, ownWait("done"));
    await expect(railBot(page, "main")).toHaveCount(0);
    await expect(railBot(page, "Otto")).toBeVisible();
  });

  test("F-562: the gateway's own bot opened from a link stays kept through the switch, while the person opens another of its tasks", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on`, "light");
    await setState(page, SECOND_OWN);
    const heading = page.getByRole("heading", { level: 1 });
    // Opened from a search result, out of the rail's rule.
    const found = await palette(page, "porch");
    await found.getByTestId("search-group-messages").getByRole("option").first().click();
    await expect(heading).toHaveText("Main");
    // The switch on, then another task of the same bot.
    let settings = await advanced(page);
    await settings.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    const own = railBot(page, "main").first();
    if ((await own.getAttribute("aria-expanded")) !== "true") await own.click();
    await page.getByTestId("task").filter({ hasText: "Hallway motion sensor" }).first().click();
    await expect(heading).toHaveText("Hallway motion sensor");
    // The switch off again: nobody opened another bot, so it stays.
    settings = await advanced(page);
    await settings.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(heading).toHaveText("Hallway motion sensor");
    await expect(railBot(page, "main")).toBeVisible();
  });

  test("F-562: a gateway's own bot kept open on one gateway is neither listed nor opened on another whose own bot has the same id", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on`, "light");
    // The gateway's own bot (`main`), opened from a search result and kept.
    const found = await palette(page, "porch");
    await found.getByTestId("search-group-messages").getByRole("option").first().click();
    await expect(page.getByTestId("transcript")).toContainText(OWN_WORDS);
    await expect(railBot(page, "main")).toBeVisible();
    // Another gateway, whose own bot is also `main` and hidden.
    await setState(
      page,
      `(state) => ({ ...state, connection: { ...state.connection, gatewayId: "another-gateway" } })`,
    );
    await expect(railBot(page, "main")).toHaveCount(0);
    await expect(page.getByTestId("transcript")).not.toContainText(OWN_WORDS);
    await expect(railBot(page, "Marlow")).toBeVisible();
  });

  test("F-562: a gateway's own bot kept open stays open, listed and saved through a reconnect to the same gateway, before and after its name returns", async ({
    page,
  }) => {
    await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off&search=on`, "light");
    const transcript = page.getByTestId("transcript");
    const found = await palette(page, "porch");
    await found.getByTestId("search-group-messages").getByRole("option").first().click();
    await expect(transcript).toContainText(OWN_WORDS);
    const saved = () => page.evaluate(() => localStorage.getItem("clawtrate.bot"));
    expect(await saved()).toBe("main");
    const named = await page.evaluate(
      () =>
        (
          window as unknown as {
            clawtrateFixture: { getState(): { connection: { gatewayId: string | null } } };
          }
        ).clawtrateFixture.getState().connection.gatewayId,
    );
    expect(named, "the fixture's gateway has a name").not.toBeNull();
    // The connection drops, and comes back on the same target with the identity answer held.
    await setState(
      page,
      `(state) => ({ ...state, connection: { ...state.connection, status: "reconnecting", gatewayId: null } })`,
    );
    await setState(
      page,
      `(state) => ({ ...state, connection: { ...state.connection, status: "connected", gatewayId: null } })`,
    );
    await expect(railBot(page, "main")).toBeVisible();
    await expect(transcript).toContainText(OWN_WORDS);
    expect(await saved()).toBe("main");
    // The name returns.
    await setState(
      page,
      `(state) => ({ ...state, connection: { ...state.connection, gatewayId: ${JSON.stringify(named)} } })`,
    );
    await expect(railBot(page, "main")).toBeVisible();
    await expect(transcript).toContainText(OWN_WORDS);
    expect(await saved()).toBe("main");
  });

  test("F-562: a new routine whose bot is deleted falls back to a bot the rail lists, never the gateway's own", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&routines=on&access=admin&gatewaybot=off`, "light");
    const back = page.getByRole("button", { name: "Back to bots" });
    if (await back.isVisible().catch(() => false)) await back.click();
    await page.getByRole("button", { name: "Routines", exact: true }).click();
    const view = page.getByTestId("routines-view");
    await view.getByTestId("new-routine").click();
    const editor = page.getByTestId("routine-editor");
    await expect(editor.getByRole("heading", { name: "New routine" })).toBeVisible();
    const select = editor.getByLabel("Bot");
    await select.selectOption({ label: "Pip" });
    // Pip deleted elsewhere while the draft is for it.
    await setState(
      page,
      `(state) => ({ ...state, bots: state.bots.filter((bot) => bot.id !== "pip") })`,
    );
    await expect(select).toHaveValue("clawtrate-main-bot");
    await expect(select.locator("option", { hasText: /^main$/ })).toHaveCount(0);
  });

  test("F-562: the open bot gives way when it leaves the rail, and a link to one of its tasks still opens that task, listed until another bot is opened", async ({
    page,
  }) => {
    await openFixture(
      page,
      `bot=main&task=${OWN_MAIN}&panel=closed&search=on&gatewaybot=on`,
      "light",
    );
    const transcript = page.getByTestId("transcript");
    await expect(transcript).toContainText(OWN_WORDS);
    // A second task of its own, which the search below finds.
    await setState(page, SECOND_OWN);
    const settings = await advanced(page);
    await settings.getByRole("switch", { name: "Show the gateway's own bot" }).click();
    await page.keyboard.press("Escape");
    await expect(railBot(page, "main")).toHaveCount(0);
    // Another bot opens: the first the rail lists, Juniper.
    await expect(transcript).not.toContainText(OWN_WORDS);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Heat pump/);
    // A message found in one of its tasks opens that task. Opened, the bot is in the rail until
    // another is opened.
    const found = await palette(page, "porch");
    await found
      .getByTestId("search-group-messages")
      .getByRole("option")
      .filter({ hasText: "Hallway motion sensor" })
      .first()
      .click();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Hallway motion sensor");
    await expect(transcript).toContainText(OWN_WORDS);
    await expect(railBot(page, "main")).toBeVisible();
    await railBot(page, "Pip").click();
    await expect(railBot(page, "main")).toHaveCount(0);
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
      await openFixture(page, `${OTTO_DISK}&panel=closed&gatewaybot=off`);
      await setState(page, ownWait("waiting"));
      await showList(page);
      await expect(railBot(page, "main")).toHaveAccessibleName(/waiting for you/);
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
