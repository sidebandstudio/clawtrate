// The search palette's behaviour in the fixture (docs/design/search.md): how it
// opens and closes, which groups it draws, opening a result where it lives,
// nothing found, and the partial, failed and offline states. The fixture's
// messages, files and routines are made up (apps/desktop/src/fixture/search.ts);
// the gateway's part is checked against a development gateway in e2e/search.spec.ts.
import type { ClawtrateState } from "../packages/core/src/index.ts";
import { expect, test, type Page } from "@playwright/test";
import { contextFor, openFixture, OTTO_DISK, SIZES } from "./fixture.ts";

const WIDE = SIZES.find((size) => size.name === "1440")!;
const DRAWER = SIZES.find((size) => size.name === "1100")!;
const PHONE = SIZES.find((size) => size.phone)!;
const BASE = `scene=main&${OTTO_DISK}&search=on&routines=on`;

const palette = (page: Page) => page.getByTestId("search-palette");
const field = (page: Page) => palette(page).getByRole("combobox", { name: "Search" });
const group = (page: Page, id: string) => palette(page).getByTestId(`search-group-${id}`);
const options = (page: Page, id: string) => group(page, id).getByRole("option");
const announcer = (page: Page) => palette(page).getByTestId("search-announcer");

async function search(page: Page, text: string, query = BASE) {
  await openFixture(page, query, "light");
  await page.keyboard.press("ControlOrMeta+K");
  await expect(field(page)).toBeFocused();
  await page.keyboard.type(text);
  await expect(announcer(page)).not.toHaveText("");
}

const sent = (page: Page, type: string) =>
  page.evaluate(
    (type) =>
      (
        window as unknown as {
          clawtrateFixture: { sent: Array<{ type: string; botId?: string; offset?: number }> };
        }
      ).clawtrateFixture.sent.filter((each) => each.type === type),
    type,
  );

/** The fixture bridge's controls for a check (apps/desktop/src/fixture/bridge-fixture.ts). */
type Fixture = {
  hold(): void;
  release(): void;
  setState(change: (state: ClawtrateState) => ClawtrateState): void;
  sent: Array<{ type: string; key?: string }>;
  send(command: { type: string; key?: string }): Promise<void>;
  sendFrom(view: string, command: { type: string; key?: string }): Promise<void>;
  getState(): ClawtrateState;
  holds(key: string): number;
  answerReread?: () => void;
};

/** Hold the fixture's delayed answers and drop a task's loaded history, so opening it reads it again. */
const unload = (page: Page, key: string) =>
  page.evaluate((key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.hold();
    fixture.setState((state) => {
      const transcripts = { ...state.transcripts };
      delete transcripts[key];
      return { ...state, transcripts };
    });
  }, key);

/** Make a task's loaded history one the gateway failed to read. */
const fail = (page: Page, key: string) =>
  page.evaluate((key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      transcripts: {
        ...state.transcripts,
        [key]: { ...state.transcripts[key]!, status: "error", error: "the gateway didn't answer" },
      },
    }));
  }, key);

const hold = (page: Page) =>
  page.evaluate(() => (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.hold());
const release = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.release(),
  );

/** Release what the fixture holds, then the open and close commands sent for a task, in order. */
const sessionsAfter = (page: Page, key: string) =>
  page.evaluate(async (key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.release();
    // What a released answer starts runs in promise callbacks: one task later, it has been sent.
    await new Promise((resolve) => setTimeout(resolve));
    return fixture.sent
      .filter((each) => each.key === key && /^(open|close)Session$/.test(each.type))
      .map((each) => each.type);
  }, key);

test.use(contextFor(WIDE, "light"));

test("F-033: Cmd/Ctrl+K opens the palette from anywhere, the rail's Search button opens it too, and Escape returns focus", async ({
  page,
}) => {
  await openFixture(page, BASE, "light");
  // From inside the conversation.
  const composer = page.locator(".transcript");
  await composer.focus();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(palette(page)).toBeVisible();
  await expect(palette(page)).toHaveAccessibleName("Search");
  await expect(field(page)).toBeFocused();
  await expect(field(page)).toHaveAttribute(
    "placeholder",
    "Search bots, tasks, messages, files, links, routines and settings",
  );
  // Before anything is typed: the field and the footer of keys, and no panel explaining search.
  await expect(palette(page).locator(".s-body")).toHaveCount(0);
  await expect(palette(page)).not.toContainText("What search looks in");
  await expect(palette(page).locator(".s-foot")).toHaveText("↑↓ Move · ↵ Open · Esc Close");
  // Everything behind it is out of reach, and its keys stay with it: ⌘K selects the text.
  await page.keyboard.type("disk");
  await page.keyboard.press("ControlOrMeta+K");
  expect(
    await field(page).evaluate(
      (input: HTMLInputElement) => input.selectionEnd! - input.selectionStart!,
    ),
  ).toBe(4);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  await expect(composer).toBeFocused();
  // Closing it forgets the query.
  await page.keyboard.press("ControlOrMeta+K");
  await expect(field(page)).toHaveValue("");
  await page.keyboard.press("Escape");

  const button = page.locator(".rail-top").getByRole("button", { name: "Search", exact: true });
  await expect(button).toHaveAttribute("aria-haspopup", "dialog");
  await expect(button).toHaveAttribute("title", /^Search \((⌘K|Ctrl\+K)\)$/);
  await button.click();
  await expect(field(page)).toBeFocused();
  // A click on the scrim closes it too.
  await page.mouse.click(20, 880);
  await expect(palette(page)).toHaveCount(0);
  // Not while another dialog is open.
  await page.keyboard.press("ControlOrMeta+,");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(palette(page)).toHaveCount(0);
});

test("F-033: one query searches bots, tasks, messages, files, links, routines and settings, and only the groups that found something are drawn", async ({
  page,
}) => {
  // "e" reaches every source but files, which ask for two characters, so Files isn't drawn.
  await search(page, "e", `${BASE}&src=truncated`);
  const names = await palette(page).locator(".s-group .s-group-name").allTextContents();
  expect(names).toEqual([
    expect.stringMatching(/^Bots · \d+$/),
    expect.stringMatching(/^Tasks · \d+$/),
    expect.stringMatching(/^Messages · \d+$/),
    expect.stringMatching(/^Links · \d+$/),
    expect.stringMatching(/^Routines · \d+$/),
    expect.stringMatching(/^Settings · \d+$/),
  ]);
  await expect(group(page, "files")).toHaveCount(0);
  await expect(options(page, "bots").first()).toHaveAccessibleName("Bot Juniper, research");
  // The device's own matches mark what it found; a snippet carries no marks.
  await expect(options(page, "bots").first().locator("b")).toHaveText("e");
  await expect(group(page, "messages").locator(".s-second b")).toHaveCount(0);
  // A group is its heading and its results: no line says how search works.
  await expect(palette(page).locator(".s-group-lines")).toHaveCount(0);
  for (const words of [
    "Titles in this device's task list, which keeps up to 500 tasks",
    "Showing the 25 matches the gateway returned, newest first. More indexed messages match.",
    "Only from the",
    "this device has loaded",
    "Matches routine names, descriptions and bot details",
  ])
    await expect(palette(page)).not.toContainText(words);
  // "More indexed messages match" is now the action that searches further.
  await expect(
    options(page, "messages").filter({ hasText: "Search each bot for more" }),
  ).toHaveCount(1);
  // Five rows, then Show all, which shows the rest in place.
  await expect(group(page, "tasks").locator('[role="option"]:not(.s-action)')).toHaveCount(5);
  const all = options(page, "tasks").filter({ hasText: /^Show all \d+ tasks$/ });
  await all.click();
  expect(await options(page, "tasks").count()).toBeGreaterThan(6);
  // Messages and routines go to the gateway once typing pauses; files with two characters.
  expect(await sent(page, "searchMessages")).toEqual([
    { type: "searchMessages", query: "e", botId: null },
  ]);
  expect(await sent(page, "searchRoutines")).toEqual([
    { type: "searchRoutines", query: "e", offset: 0 },
  ]);
  expect(await sent(page, "searchFiles")).toEqual([]);

  await field(page).fill("acc");
  await expect(options(page, "settings").first()).toHaveAccessibleName("Setting Accounts");
  await expect(announcer(page)).toHaveText("1 result: 1 setting.");
  // Only Settings found something. The message reply was cut short (`src=truncated`), so Messages
  // is its heading, with no count, and the action that searches further; nothing else is drawn.
  await expect(palette(page).locator(".s-group .s-group-name")).toHaveText([
    "Messages",
    "Settings · 1",
  ]);
  await expect(options(page, "messages")).toHaveText(["Search each bot for more"]);
  await expect(palette(page)).not.toContainText("No matches in");
  await expect(palette(page).getByTestId("search-status")).toHaveCount(0);
});

test("F-033: a search that finds nothing says so in one line, after one quiet line while the gateway answers", async ({
  page,
}) => {
  await openFixture(page, BASE, "light");
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.hold(),
  );
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("zzqx");
  const status = palette(page).getByTestId("search-status");
  await expect(status).toHaveText("Searching…");
  await expect(palette(page).locator(".s-group")).toHaveCount(0);
  await expect(announcer(page)).toHaveText("");
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.release(),
  );
  await expect(status).toHaveText("No results for “zzqx”.");
  await expect(palette(page).locator(".s-group")).toHaveCount(0);
  await expect(palette(page).getByRole("option")).toHaveCount(0);
  await expect(announcer(page)).toHaveText("No results for “zzqx”.");
});

test("F-033: a message search the gateway left incomplete offers Search each bot for more with no match too, and says what it left out", async ({
  page,
}) => {
  const lines = () => palette(page).getByTestId("search-status").locator(".s-status");
  const each = () => options(page, "messages").filter({ hasText: "Search each bot for more" });
  for (const [src, said] of [
    ["truncated", []],
    ["indexing", ["Some messages are still being indexed."]],
    ["archive", ["Older messages in 4 tasks weren't searched."]],
  ] as const) {
    await search(page, "kayak", `${BASE}&src=${src}`);
    // Nothing found, said first; then Messages as its heading and the action, with no count.
    await expect(lines()).toHaveText(["No results for “kayak”.", ...said]);
    await expect(announcer(page)).toHaveText(["No results for “kayak”.", ...said].join(" "));
    await expect(group(page, "messages").locator(".s-group-name")).toHaveText("Messages");
    await expect(group(page, "messages").locator(".s-group-lines")).toHaveCount(0);
    await expect(options(page, "messages")).toHaveText(["Search each bot for more"]);
    await expect(palette(page).locator(".s-group")).toHaveCount(1);
  }
  // A complete reply with nothing found: no Messages group, no action.
  await search(page, "kayak");
  await expect(lines()).toHaveText(["No results for “kayak”."]);
  await expect(group(page, "messages")).toHaveCount(0);
  // Beside matches the archive line is Messages' own, with the action.
  await search(page, "transcode", `${BASE}&src=archive`);
  await expect(group(page, "messages").locator(".s-group-lines")).toHaveText(
    "Older messages in 4 tasks weren't searched.",
  );
  await expect(each()).toHaveCount(1);
  await expect(palette(page).getByTestId("search-status")).toHaveCount(0);
  // The action asks each bot, and the first reply's left-out lines give way to theirs.
  await search(page, "kayak", `${BASE}&src=archive`);
  await each().click();
  await expect(each()).toHaveCount(0);
  await expect(lines()).toHaveText(["No results for “kayak”."]);
  expect((await sent(page, "searchMessages")).filter((one) => one.botId).length).toBeGreaterThan(0);
});

test("F-033: while the gateway is still indexing, a search that finds no message says so beside No results, and beside matches", async ({
  page,
}) => {
  const lines = () => palette(page).getByTestId("search-status").locator(".s-status");
  // Nothing found, the gateway's reply saying `indexing`: both lines, said in that order.
  await search(page, "kayak", `${BASE}&src=indexing`);
  await expect(lines()).toHaveText([
    "No results for “kayak”.",
    "Some messages are still being indexed.",
  ]);
  await expect(announcer(page)).toHaveText(
    "No results for “kayak”. Some messages are still being indexed.",
  );
  // Nothing found with indexing done: the one line.
  await search(page, "kayak");
  await expect(lines()).toHaveText(["No results for “kayak”."]);
  await expect(announcer(page)).toHaveText("No results for “kayak”.");
  // Matches while indexing: Messages says it under its heading, and no status line repeats it.
  await search(page, "transcode", `${BASE}&src=indexing`);
  await expect(group(page, "messages").locator(".s-group-lines")).toHaveText(
    "Some messages are still being indexed.",
  );
  await expect(palette(page).getByTestId("search-status")).toHaveCount(0);
  await expect(announcer(page)).toHaveText(
    "3 results: 3 messages. Some messages are still being indexed.",
  );
  // No message found while indexing, but a task was: Messages is its heading and its action only,
  // so the line stands with the search's own lines.
  await search(page, "weekly", `${BASE}&src=indexing`);
  await expect(group(page, "tasks")).toBeVisible();
  await expect(group(page, "messages").locator(".s-group-name")).toHaveText("Messages");
  await expect(options(page, "messages")).toHaveText(["Search each bot for more"]);
  await expect(lines()).toHaveText(["Some messages are still being indexed."]);
  await expect(announcer(page)).toHaveText(
    "1 result: 1 task. Some messages are still being indexed.",
  );
});

test("F-033: Enter opens a bot, a task, a routine and a setting where it lives, and closes the palette", async ({
  page,
}) => {
  await search(page, "marlow");
  await expect(options(page, "bots").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".title-pill")).toContainText("Marlow");

  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("router");
  await expect(options(page, "tasks").first()).toHaveAccessibleName(/^Task Router firmware, Otto/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".title-pill-task")).toHaveText("Router firmware");

  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("tidy");
  await expect(options(page, "routines").first()).toHaveAccessibleName(
    "Routine Inbox tidy-up, Pip, off. Opens routine.",
  );
  await expect(options(page, "routines").first()).toContainText("Pip · Off");
  await options(page, "routines").first().click();
  await expect(page.getByTestId("routines-view")).toContainText("Inbox tidy-up");

  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("machines");
  await page.keyboard.press("Enter");
  const settings = page.getByRole("dialog", { name: "Settings" });
  await expect(settings.locator("#b-section-title")).toHaveText("Machines");
});

test("F-033: a message opens in its conversation, scrolled into view and ringed, and the announcer says where", async ({
  page,
}) => {
  await search(page, "clear the transcode", `scene=main&bot=pip&task=agent:pip:week&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toHaveAccessibleName(
    /^Message in Disk almost full on the media box, from a user, Nov 16: Yes, clear the transcode cache\.$/,
  );
  await user.click();
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".title-pill-task")).toHaveText("Disk almost full on the media box");
  const unit = page
    .locator(".transcript .msg-unit")
    .filter({ hasText: "Yes, clear the transcode cache." });
  await expect(unit).toBeInViewport();
  await expect(unit.locator(".bubble")).toHaveClass(/search-hit/);
  const turn = page.locator(".turn[data-search-focus]");
  await expect(turn).toBeFocused();
  await expect(turn).toContainText("Yes, clear the transcode cache.");
  await expect(page.getByTestId("chat-link-announcer")).toHaveText(
    "Opened Disk almost full on the media box, at the user message of Nov 16",
  );
});

test("F-033: a message whose conversation is replaced while its history loads stays in search and says so", async ({
  page,
}) => {
  const key = "agent:otto:disk-space";
  await search(page, "clear the transcode", `scene=main&bot=pip&task=agent:pip:week&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await unload(page, key);
  await user.click();
  await expect(user).toContainText("Opening…");
  // A new session takes the same key before the history comes.
  await page.evaluate((key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      tasksByBot: {
        ...state.tasksByBot,
        otto: state.tasksByBot.otto!.map((task) =>
          task.key === key ? { ...task, sessionId: "otto-disk-space-2" } : task,
        ),
      },
    }));
    fixture.release();
  }, key);
  await expect(user).toContainText(
    "This task's conversation was replaced since the search. Search again.",
  );
  await expect(palette(page)).toBeVisible();
  await expect(page.locator(".title-pill-task")).not.toHaveText(
    "Disk almost full on the media box",
  );
});

test("F-033: a message whose history comes as the connection's access changes doesn't open", async ({
  page,
}) => {
  await search(page, "clear the transcode", `scene=main&bot=pip&task=agent:pip:week&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await unload(page, "agent:otto:disk-space");
  await user.click();
  await expect(user).toContainText("Opening…");
  // The history and the change of scopes reach the palette together.
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      connection: {
        ...state.connection,
        scopes: [...state.connection.scopes, "operator.approvals"],
      },
    }));
    fixture.release();
    // The search the change starts again stays pending, so its state can be seen.
    fixture.hold();
  });
  // Asked again, Messages has found nothing yet: it isn't drawn, and the status line says so.
  await expect(palette(page).getByTestId("search-status")).toHaveText("Searching…");
  await expect(group(page, "messages")).toHaveCount(0);
  await expect(palette(page)).toBeVisible();
  await expect(page.locator(".title-pill-task")).not.toHaveText(
    "Disk almost full on the media box",
  );
});

test("F-033: Try again opens a result whose first open was refused", async ({ page }) => {
  const key = "agent:otto:disk-space";
  await search(page, "clear the transcode", "scene=main&bot=pip&task=agent:pip:week&search=on");
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await unload(page, key);
  await page.evaluate((key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const send = fixture.send;
    fixture.send = async (command) => {
      if (command.type === "openSession" && command.key === key) {
        fixture.send = send;
        throw new Error("At most 8 tasks can be open at once.");
      }
      return send(command);
    };
  }, key);
  await user.click();
  await expect(user).toContainText("At most 8 tasks can be open at once.");
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  // Only an open acquires the slot that became available.
  await expect.poll(() => sent(page, "openSession")).toContainEqual({ type: "openSession", key });
  await release(page);
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".turn[data-search-focus]")).toBeFocused();
});

test("F-033: Try again on a history that failed opens the message once the history loads", async ({
  page,
}) => {
  await search(page, "clear the transcode", `scene=main&bot=pip&task=agent:pip:week&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await fail(page, "agent:otto:disk-space");
  await user.click();
  await expect(user).toContainText("Couldn't load this conversation: the gateway didn't answer.");
  await hold(page);
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  // The failed history is still in view until the new read answers; it doesn't decide.
  await expect(user).toContainText("Opening…");
  await release(page);
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".title-pill-task")).toHaveText("Disk almost full on the media box");
  await expect(page.locator(".turn[data-search-focus]")).toBeFocused();
});

/**
 * The host refuses the next reread of `key`, as from a view that no longer holds it, once
 * `answerReread` is called.
 */
const refuseReread = (page: Page, key: string) =>
  page.evaluate((key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const send = fixture.send;
    fixture.send = async (command) => {
      if (command.type === "reloadSession" && command.key === key) {
        fixture.send = send;
        await new Promise<void>((resolve) => (fixture.answerReread = resolve));
        throw new Error("That task isn't open in this view.");
      }
      return send(command);
    };
  }, key);
const answerReread = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.answerReread?.(),
  );
const holds = (page: Page, key: string) =>
  page.evaluate(
    (key) => (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.holds(key),
    key,
  );

test("F-033: Try again in a view the host no longer counts opens the message once another view has read the history", async ({
  page,
}) => {
  const key = "agent:otto:disk-space";
  await search(page, "clear the transcode", `scene=main&${OTTO_DISK}&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await fail(page, key);
  await user.click();
  await expect(user).toContainText("Couldn't load this conversation");
  await refuseReread(page, key);
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  await expect(user).toContainText("Opening…");
  // Another view reads the history again before the refusal comes, so this view's open
  // finds it loaded and changes nothing.
  await page.evaluate(
    (key) =>
      (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.send({
        type: "reloadSession",
        key,
      }),
    key,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (key) =>
          (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.getState()
            .transcripts[key]?.status,
        key,
      ),
    )
    .toBe("ready");
  await answerReread(page);
  await expect(palette(page)).toHaveCount(0);
  await expect(page.locator(".turn[data-search-focus]")).toBeFocused();
});

test("F-033: a refusal of Try again that comes after search closed opens nothing", async ({
  page,
}) => {
  const key = "agent:otto:disk-space";
  await search(page, "clear the transcode", `scene=main&${OTTO_DISK}&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await fail(page, key);
  await user.click();
  await expect(user).toContainText("Couldn't load this conversation");
  await refuseReread(page, key);
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  await expect(user).toContainText("Opening…");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  // Only the shell holds the task.
  expect(await holds(page, key)).toBe(1);
  await answerReread(page);
  expect(await holds(page, key)).toBe(1);
});

test("F-033: Try again on the selected task's failed history leaves that task open after search closes", async ({
  page,
}) => {
  const key = "agent:otto:disk-space";
  await search(page, "clear the transcode", `scene=main&${OTTO_DISK}&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await fail(page, key);
  await user.click();
  await expect(user).toContainText("Couldn't load this conversation");
  await hold(page);
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  await expect(user).toContainText("Opening…");
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  // The shell still shows the task, so the retry reopens it once its close is answered,
  // and the palette never closes a task it didn't open.
  expect((await sessionsAfter(page, key)).at(-1)).toBe("openSession");
});

test("F-033: after a retry, choosing a message in another unloaded task leaves neither task open once search closes", async ({
  page,
}) => {
  const first = "agent:otto:disk-space";
  const second = "agent:otto:rotate-logs";
  await search(page, "disk", `scene=main&bot=pip&task=agent:pip:week&search=on`);
  const all = options(page, "messages").filter({ hasText: /^Show all \d+ messages$/ });
  if (await all.count()) await all.click();
  const a = options(page, "messages").filter({ hasText: "The disk is now at 61%" });
  const b = options(page, "messages").filter({ hasText: "before the disks fill up again" });
  await expect(a).toBeVisible();
  await expect(b).toBeVisible();
  // Neither task's history is loaded; search opens the first, and its read fails.
  await unload(page, first);
  await unload(page, second);
  await a.click();
  await expect(a).toContainText("Opening…");
  await fail(page, first);
  await expect(a).toContainText("Couldn't load this conversation");
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  await expect(a).toContainText("Opening…");
  // Another unloaded task's message is chosen while the retry is unanswered; its read fails too.
  await b.click();
  await expect(b).toContainText("Opening…");
  await fail(page, second);
  await expect(b).toContainText("Couldn't load this conversation");
  await release(page);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  expect((await sessionsAfter(page, first)).at(-1)).toBe("closeSession");
  expect((await sessionsAfter(page, second)).at(-1)).toBe("closeSession");
});

test("F-033: a retry of the selected task's history doesn't reopen it once the shell has moved to another task", async ({
  page,
}) => {
  const key = "agent:otto:disk-space";
  await search(page, "clear the transcode", `scene=main&${OTTO_DISK}&search=on`);
  const user = options(page, "messages").filter({ hasText: "· User" });
  await expect(user).toBeVisible();
  await fail(page, key);
  await user.click();
  await expect(user).toContainText("Couldn't load this conversation");
  await hold(page);
  await options(page, "messages")
    .filter({ hasText: /^Try again$/ })
    .click();
  await expect(user).toContainText("Opening…");
  // Another task is chosen while the retry's close is still unanswered.
  await field(page).fill("router");
  await expect(options(page, "tasks").first()).toHaveAccessibleName(/^Task Router firmware, Otto/);
  await page.keyboard.press("Enter");
  await expect(page.locator(".title-pill-task")).toHaveText("Router firmware");
  // The shell released the old task; the retry's answer must not take it back.
  expect((await sessionsAfter(page, key)).at(-1)).toBe("closeSession");
});

test("the fixture reads a history again after pairing, and drops a read that a disconnect overtook", async ({
  page,
}) => {
  const key = "agent:otto:disk-space";
  // Paired by the second "Check now": the histories it loads can be read again.
  await openFixture(page, "scene=pairing&search=on", "light");
  const reread = await page.evaluate(async (key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    await fixture.send({ type: "retry" });
    await fixture.send({ type: "retry" });
    fixture.hold();
    fixture.setState((state) => {
      const transcripts = { ...state.transcripts };
      delete transcripts[key];
      return { ...state, transcripts };
    });
    // A second view opens the task, so the dropped history is read again.
    await fixture.sendFrom("other", { type: "openSession", key });
    const reading = fixture.getState().transcripts[key]?.status;
    fixture.release();
    return [reading, fixture.getState().transcripts[key]?.status];
  }, key);
  expect(reread).toEqual(["loading", "ready"]);

  // A disconnect before the history answers clears the task; the late answer doesn't bring it back.
  await openFixture(page, `scene=main&search=on`, "light");
  const after = await page.evaluate(async (key) => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.hold();
    fixture.setState((state) => {
      const transcripts = { ...state.transcripts };
      delete transcripts[key];
      return { ...state, transcripts };
    });
    await fixture.sendFrom("other", { type: "openSession", key });
    await fixture.send({ type: "disconnect" });
    fixture.release();
    return fixture.getState().transcripts[key];
  }, key);
  expect(after).toBeUndefined();
});

test("F-033: closing search stops the per-bot searches still queued", async ({ page }) => {
  await search(page, "backup", `${BASE}&src=truncated`);
  await page.evaluate(() =>
    (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture.hold(),
  );
  await options(page, "messages").filter({ hasText: "Search each bot for more" }).click();
  // The wide search, then four of the five bots; the fifth waits for a free lane.
  await expect.poll(async () => (await sent(page, "searchMessages")).length).toBe(5);
  await page.keyboard.press("Escape");
  await expect(palette(page)).toHaveCount(0);
  const after = await page.evaluate(async () => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.release();
    // The lanes go on in promise callbacks: one task later, any next search has been sent.
    await new Promise((resolve) => setTimeout(resolve));
    return fixture.sent.filter((each) => each.type === "searchMessages").length;
  });
  expect(after).toBe(5);
});

test("F-033: asked before the bots load, Files searches once they come", async ({ page }) => {
  await openFixture(page, BASE, "light");
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => {
      (window as unknown as { keptBots: unknown }).keptBots = state.bots;
      return { ...state, bots: [] };
    });
  });
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("md");
  await expect(announcer(page)).not.toHaveText("");
  await expect(group(page, "files")).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    const bots = (window as unknown as { keptBots: ClawtrateState["bots"] }).keptBots;
    fixture.setState((state) => ({ ...state, bots }));
  });
  await expect(options(page, "files").first()).toBeVisible();
  expect((await sent(page, "searchMessages")).length).toBe(1);
});

test("F-033: Enter that confirms an input method's text doesn't open the active result", async ({
  page,
}) => {
  await search(page, "marlow");
  await expect(options(page, "bots").first()).toHaveAttribute("aria-selected", "true");
  await field(page).dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(palette(page)).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(palette(page)).toHaveCount(0);
});

test.describe("at phone width", () => {
  test.use(contextFor(PHONE, "light"));

  test("F-033: Tab reaches Cancel, and Enter on it closes search without opening a result", async ({
    page,
  }) => {
    await search(page, "marlow");
    await expect(options(page, "bots").first()).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await expect(palette(page).getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator(".title-pill")).not.toContainText("Marlow");
  });
});

test.describe("at drawer width", () => {
  test.use(contextFor(DRAWER, "light"));

  test("F-033: with Work open as a drawer, a message opened from search closes Work, shows the message and focuses it", async ({
    page,
  }) => {
    await openFixture(page, `scene=main&bot=pip&task=agent:pip:week&search=on&panel=open`, "light");
    await expect(page.getByTestId("work-panel")).toHaveAttribute("role", "dialog");
    await page.keyboard.press("ControlOrMeta+K");
    await expect(field(page)).toBeFocused();
    await page.keyboard.type("clear the transcode");
    const user = options(page, "messages").filter({ hasText: "· User" });
    await user.click();
    await expect(palette(page)).toHaveCount(0);
    await expect(page.locator(".shell")).toHaveAttribute("data-panel", "closed");
    const unit = page
      .locator(".transcript .msg-unit")
      .filter({ hasText: "Yes, clear the transcode cache." });
    await expect(unit).toBeInViewport();
    const turn = page.locator(".turn[data-search-focus]");
    await expect(turn).toBeFocused();
    await expect(turn).toContainText("Yes, clear the transcode cache.");
  });
});

test("F-033: a routine past the ones this device keeps opens its page, read with its bot's routines", async ({
  page,
}) => {
  await search(page, "trail", `scene=main&${OTTO_DISK}&search=on&routines=truncated`);
  const routine = options(page, "routines").first();
  await expect(routine).toHaveAccessibleName("Routine Trail conditions, Pip, on. Opens routine.");
  await routine.click();
  await expect(palette(page)).toHaveCount(0);
  await expect(
    page.getByTestId("routines-view").getByRole("heading", { name: "Trail conditions" }),
  ).toBeVisible();
  expect(await sent(page, "readBotRoutines")).toEqual([{ type: "readBotRoutines", botId: "pip" }]);
});

test("F-033: a message that can't be shown in place says why, and the palette stays", async ({
  page,
}) => {
  await search(page, "transcode", `${BASE}&src=missing,gone`);
  const missing = options(page, "messages").filter({ hasText: "back under 20 GB" });
  await missing.click();
  await expect(palette(page)).toBeVisible();
  await expect(group(page, "messages")).toContainText(
    "This message isn't in the conversation's loaded messages.",
  );
  const latest = options(page, "messages").filter({ hasText: "Open the task at its latest" });
  await expect(latest).toBeVisible();

  // A task the list doesn't hold, whose history no longer holds the match.
  const unlisted = options(page, "messages").filter({ hasText: "Old transcode queue" });
  await unlisted.click();
  await expect(group(page, "messages")).toContainText(
    "This task isn't in this device's task list, which keeps up to 500 tasks.",
  );
  await expect(palette(page)).toBeVisible();
  await expect(latest).toHaveCount(0);
});

test("F-033: a failed source says so with Try again and leaves the others alone; Search each bot for more answers bot by bot", async ({
  page,
}) => {
  await search(page, "backup", `${BASE}&src=msgfail,eachfail,truncated`);
  await expect(group(page, "messages")).toHaveAttribute("data-tone", "danger");
  await expect(group(page, "messages")).toContainText(
    "Couldn't search messages: the gateway didn't answer in time.",
  );
  await expect(options(page, "tasks").first()).toContainText("Weekly backup check");
  await expect(announcer(page)).toContainText("Messages couldn't be searched.");
  await options(page, "messages").filter({ hasText: "Try again" }).click();
  await options(page, "messages").filter({ hasText: "Search each bot for more" }).click();
  await expect(options(page, "messages").filter({ hasText: "Try again for Pip" })).toBeVisible();
  // Only the failure has a line: no tally of bots, no line per bot that answered or found nothing.
  await expect(group(page, "messages").locator(".s-sub")).toHaveText([
    "Pip · couldn't search: the search index is busy",
  ]);
  await expect(group(page, "messages")).not.toContainText("bots answered");
  await expect(group(page, "messages")).not.toContainText("all 2 matches");
  // The live region names the bot that couldn't be searched, as the screen does.
  await expect(announcer(page)).toContainText("Pip · couldn't search: the search index is busy");
  await expect(options(page, "messages").filter({ hasText: "· Otto" })).not.toHaveCount(0);
  expect((await sent(page, "searchMessages")).map((each) => each.botId)).toEqual([
    null,
    null,
    "clawtrate-main-bot",
    "marlow",
    "otto",
    "pip",
    "quartermaster",
  ]);
  await options(page, "messages").filter({ hasText: "Try again for Pip" }).click();
  await expect(options(page, "messages").filter({ hasText: "Try again for Pip" })).toHaveCount(0);
  await expect(group(page, "messages").locator(".s-sub")).toHaveCount(0);
});

test("F-033: past 24 bots, Search the next bots adds the next batch and keeps the earlier one's rows and retries", async ({
  page,
}) => {
  await openFixture(page, `${BASE}&src=truncated,eachfail`, "light");
  // 25 more bots, 30 in all: none has a task, so each one's own search finds nothing.
  await page.evaluate(() => {
    const fixture = (window as unknown as { clawtrateFixture: Fixture }).clawtrateFixture;
    fixture.setState((state) => ({
      ...state,
      bots: [
        ...state.bots,
        ...Array.from({ length: 25 }, (_, i) => ({
          ...state.bots.find((bot) => bot.id === "clawtrate-main-bot")!,
          id: `extra-${i + 1}`,
          name: `Extra ${i + 1}`,
        })),
      ],
    }));
  });
  await page.keyboard.press("ControlOrMeta+K");
  await page.keyboard.type("backup");
  await options(page, "messages").filter({ hasText: "Search each bot for more" }).click();
  await expect(options(page, "messages").filter({ hasText: "Try again for Pip" })).toBeVisible();
  const next = options(page, "messages").filter({ hasText: /^Search the next 6 bots$/ });
  await expect(next).toBeVisible();
  await expect(group(page, "messages")).not.toContainText("Not asked");
  await expect(group(page, "messages")).not.toContainText("bots answered");
  await next.click();
  await expect
    .poll(async () => (await sent(page, "searchMessages")).filter((each) => each.botId).length)
    .toBe(30);
  await expect(next).toHaveCount(0);
  await expect(options(page, "messages").filter({ hasText: "· Otto" })).not.toHaveCount(0);
  await expect(group(page, "messages")).not.toContainText("Extra 25");
  await expect(options(page, "messages").filter({ hasText: "Try again for Pip" })).toBeVisible();
  await options(page, "messages").filter({ hasText: "Try again for Pip" }).click();
  await expect(options(page, "messages").filter({ hasText: "Try again for Pip" })).toHaveCount(0);
});

test("F-033: routines load a page at a time, and a list that changed between pages stops paging", async ({
  page,
}) => {
  await search(page, "e", `${BASE}&routinepage=3`);
  const heading = group(page, "routines").locator(".s-group-name");
  // The heading counts what is loaded; the action says how many more there are, with no tally line.
  await expect(heading).toHaveText("Routines · 3");
  await expect(group(page, "routines")).not.toContainText("First 3 of 8");
  await options(page, "routines")
    .filter({ hasText: /^Show 3 more routines$/ })
    .click();
  await expect(heading).toHaveText("Routines · 6");
  await expect(group(page, "routines")).not.toContainText("First 6 of 8");
  await options(page, "routines")
    .filter({ hasText: /^Show 2 more routines$/ })
    .click();
  await expect(heading).toHaveText("Routines · 8");
  await expect(options(page, "routines").filter({ hasText: /more routines/ })).toHaveCount(0);
  await expect(group(page, "routines")).not.toContainText("All 8 routines");
  expect((await sent(page, "searchRoutines")).map((each) => each.offset)).toEqual([0, 3, 6]);

  await search(page, "e", `${BASE}&routinepage=3&src=routineschanged`);
  await options(page, "routines")
    .filter({ hasText: /^Show 3 more routines$/ })
    .click();
  await expect(group(page, "routines")).toContainText(
    "The list of routines changed while more were loading. Search again to see it from the start.",
  );
  await expect(options(page, "routines").filter({ hasText: /more routines/ })).toHaveCount(0);
});

test("F-033: files are searched per bot, names only, and only a refusal has a line, with its retry", async ({
  page,
}) => {
  await search(page, "md", `${BASE}&src=filesfail,filescap`);
  const files = group(page, "files");
  await expect(files.locator(".s-group-lines")).toHaveText(
    "Pip: the gateway refused the search: permission denied.",
  );
  for (const words of [
    "Names the gateway returned from the workspaces of",
    "Some folders may be skipped.",
    "Not searched: Marlow's workspace could not be verified.",
    "Otto: the gateway stopped at its limit of 500 names or 5,000 entries walked.",
    "3 of 5 bots' workspaces searched.",
  ])
    await expect(files).not.toContainText(words);
  // A file result is its name: Enter says why it opens nothing, and the palette stays.
  const notes = options(page, "files").filter({ hasText: "heat-pumps.md" });
  await expect(notes).toContainText("notes · Juniper");
  await notes.click();
  await expect(notes).toContainText(
    "Opening a file from search is unavailable until the gateway can bind the read to the workspace searched.",
  );
  await expect(palette(page)).toBeVisible();
  await options(page, "files").filter({ hasText: "Try again for Pip" }).click();
  await expect(files).not.toContainText("Pip: the gateway refused");
  await options(page, "files")
    .filter({ hasText: /^Show all \d+ files$/ })
    .click();
  await expect(options(page, "files").filter({ hasText: "mountain-weekend.md" })).toBeVisible();
});

test("F-033: offline, one line says the gateway's sources were not searched and the device's own still filter", async ({
  page,
}) => {
  await search(page, "otto", `scene=offline&${OTTO_DISK}&search=on`);
  const offline = "Messages, files and routines weren't searched: 127.0.0.1:18789 isn't connected.";
  await expect(palette(page).getByTestId("search-status")).toHaveText(offline);
  for (const id of ["messages", "files", "routines"]) await expect(group(page, id)).toHaveCount(0);
  await expect(announcer(page)).toContainText(offline);
  await expect(options(page, "bots").first()).toHaveAccessibleName(/^Bot Otto/);
  expect(await sent(page, "searchMessages")).toEqual([]);
});

test("F-033: Up, Down, Page Up and Page Down move the active row across groups, and focus stays in the field", async ({
  page,
}) => {
  await search(page, "e");
  const active = palette(page).locator('[role="option"][aria-selected="true"]');
  const ids = await palette(page)
    .getByRole("option")
    .evaluateAll((rows) => rows.map((row) => row.id));
  await expect(active).toHaveAccessibleName("Bot Juniper, research");
  await expect(field(page)).toHaveAttribute("aria-activedescendant", ids[0]!);
  await page.keyboard.press("ArrowDown");
  await expect(active).toHaveAttribute("id", ids[1]!);
  await expect(field(page)).toHaveAttribute("aria-activedescendant", ids[1]!);
  // Up stops at the first option.
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await expect(active).toHaveAttribute("id", ids[0]!);
  const groupOf = () =>
    active.evaluate((row) => row.closest("[role='group']")!.getAttribute("data-group"));
  await page.keyboard.press("PageDown");
  const second = await groupOf();
  expect(second).not.toBe("bots");
  await page.keyboard.press("PageDown");
  expect(await groupOf()).not.toBe(second);
  await page.keyboard.press("PageUp");
  expect(await groupOf()).toBe(second);
  // Focus never leaves the field, and Tab stays in the palette.
  await page.keyboard.press("Tab");
  await expect(field(page)).toBeFocused();
});

test("F-033: a bot's file search that failed keeps its line and Try again when no file matched, and is announced", async ({
  page,
}) => {
  await search(page, "kayak", `${BASE}&src=filesfail`);
  await expect(palette(page).getByTestId("search-status").locator(".s-status")).toHaveText([
    "No results for “kayak”.",
  ]);
  await expect(group(page, "files").locator(".s-group-name")).toHaveText("Files");
  await expect(group(page, "files").locator(".s-group-lines")).toHaveText(
    "Pip: the gateway refused the search: permission denied.",
  );
  await expect(options(page, "files")).toHaveText(["Try again for Pip"]);
  await expect(announcer(page)).toHaveText(
    "Pip: the gateway refused the search: permission denied. No results for “kayak”.",
  );
  // Asked again and answered with nothing, Pip's line and its retry go, and so does Files.
  await options(page, "files").filter({ hasText: "Try again for Pip" }).click();
  await expect(group(page, "files")).toHaveCount(0);
});

test("F-033: after Search each bot for more, a bot still indexing keeps its line under Messages even with no match of its own", async ({
  page,
}) => {
  await search(page, "backup", `${BASE}&src=truncated,indexing`);
  await options(page, "messages").filter({ hasText: "Search each bot for more" }).click();
  await expect(palette(page).getByTestId("search-status")).toHaveCount(0);
  const indexing = "Some messages are still being indexed.";
  // Every bot asked but Marlow says it is still indexing (the fixture's Marlow isn't); Otto has
  // matches, the others none, and each still has its line.
  await expect(group(page, "messages").locator(".s-sub")).toHaveText([
    `Juniper · ${indexing}`,
    `Otto · ${indexing}`,
    `Pip · ${indexing}`,
    `Quartermaster of the Family Calendar and Errands · ${indexing}`,
  ]);
  await expect(group(page, "messages")).not.toContainText("Marlow");
  await expect(announcer(page)).toContainText(`Pip · ${indexing}`);
});
