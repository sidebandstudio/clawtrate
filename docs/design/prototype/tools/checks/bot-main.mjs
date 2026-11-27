// Checks bot-main.html (docs/design/bot-opens-main.md) in a headless browser, from disk.
// `node docs/design/prototype/tools/checks/bot-main.mjs` prints one line per check.
// With `--pictures <folder>` it also writes the design's pictures there, dark and light.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, pageUrl } from "./browser.mjs";

const at = process.argv.indexOf("--pictures");
const pictures = at === -1 ? null : process.argv[at + 1];
let failed = 0;
let count = 0;
const check = (name, ok) => {
  count += 1;
  if (!ok) failed += 1;
  console.log(`${ok ? "ok" : "FAIL"} ${name}`);
};

const browser = await chromium.launch();
const errors = [];
const sizes = { 1100: { width: 1100, height: 720 }, phone: { width: 390, height: 844 } };
const open = async (params, size = "1100") => {
  const page = await browser.newPage({ viewport: sizes[size] });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  const query = new URLSearchParams({
    chrome: "0",
    theme: "dark",
    motion: "reduce",
    ...(size === "phone" ? { width: "phone" } : {}),
    ...params,
  });
  await page.goto(`${pageUrl("bot-main.html")}?${query}`);
  await page.evaluate(() => document.fonts.ready);
  return page;
};
// Nothing scrolls sideways, and nothing is cut at the frame's or a scroller's edge.
const noSideways = (page) =>
  page.evaluate(
    () =>
      document.documentElement.scrollWidth <= document.documentElement.clientWidth &&
      [...document.querySelectorAll(".bm-scroll, .bm-list")].every(
        (scroller) => scroller.scrollWidth <= scroller.clientWidth,
      ) &&
      [...document.querySelectorAll(".bm-card, .bm-composer, .bm-msg")].every(
        (element) => element.getBoundingClientRect().right <= document.documentElement.clientWidth,
      ),
  );

// A bot's row opens its main conversation, and "Main" is not a row.
{
  const page = await open({ bot: "juniper", task: "heat" });
  check("a task is open: its row is current", (await page.locator('.bm-task[aria-current="page"]').count()) === 1);
  await page.getByRole("button", { name: /^Marlow,/ }).click();
  check("clicking a bot opens its main conversation", (await page.locator(".bm-pill-task").count()) === 0);
  check("the header names the bot alone", (await page.locator(".bm-pill-name").textContent()) === "Marlow");
  check("the bot's row is current", (await page.locator('.bm-bot[aria-current="page"]').getAttribute("data-bot")) === "marlow");
  check("no row is called Main", (await page.getByRole("button", { name: /^Main\b/ }).count()) === 0);
  check("the open bot's tasks are listed under it", (await page.locator('.bm-task[data-bot="marlow"]:visible').count()) === 3);
  check("another bot's tasks are folded", (await page.locator('.bm-task[data-bot="juniper"]:visible').count()) === 0);
  await page.locator('.bm-task[data-task="trail"]').click();
  check("a task opens with the bot and the task in the header", (await page.locator(".bm-pill-task").textContent()) === "Trail apps compared");
  check(
    "a task a bot started names where it came from",
    (await page.locator(".bm-started-line").textContent()).startsWith("Marlow started this task from its main conversation"),
  );
  await page.locator('.bm-bot[data-bot="marlow"]').click();
  check("clicking the open bot's row goes back to its main conversation", (await page.locator(".bm-pill-task").count()) === 0);
  const fold = page.getByRole("button", { name: "Show Juniper's tasks" });
  check(
    "the fold is its own button that controls the bot's task list",
    (await fold.getAttribute("aria-expanded")) === "false" &&
      (await fold.getAttribute("aria-controls")) === "bm-tasks-juniper",
  );
  check(
    "the row's name says nothing about folding",
    (await page.locator('.bm-bot[data-bot="juniper"]').getAttribute("aria-expanded")) === null,
  );
  await fold.click();
  check(
    "after it, the fold says Hide and is expanded",
    (await page.getByRole("button", { name: "Hide Juniper's tasks" }).getAttribute("aria-expanded")) === "true",
  );
  check("the fold shows another bot's tasks without opening it", (await page.locator('.bm-task[data-bot="juniper"]:visible').count()) === 2);
  check("and the open bot stays open", (await page.locator(".bm-pill-name").textContent()) === "Marlow");
  await page.close();
}

// Keyboard: Right and Left on a row, Left from a task to its bot.
{
  const page = await open({ bot: "marlow" });
  await page.locator('.bm-bot[data-bot="otto"]').focus();
  await page.keyboard.press("ArrowRight");
  check("Right shows a bot's tasks", (await page.locator('.bm-task[data-bot="otto"]:visible').count()) === 1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowLeft");
  check(
    "Left on a task goes to its bot",
    await page.evaluate(() => document.activeElement?.dataset.bot === "otto" && document.activeElement.classList.contains("bm-bot")),
  );
  await page.keyboard.press("ArrowLeft");
  check("Left on an unfolded bot hides its tasks", (await page.locator('.bm-task[data-bot="otto"]:visible').count()) === 0);
  await page.keyboard.press("Enter");
  check("Enter on a bot opens its main conversation", (await page.locator(".bm-pill-name").textContent()) === "Otto");
  check(
    "a folded bot's name says its state, its tasks and an unread task it hides",
    (await page.locator('.bm-bot[data-bot="marlow"]').getAttribute("aria-label")) ===
      "Marlow, waiting for you, 3 tasks, unread",
  );
  await page.close();
}

// A bot with no main conversation yet opens to an empty one.
{
  const page = await open({ bot: "pip" });
  check("an empty main conversation says so", (await page.locator(".bm-empty h1").textContent()) === "Nothing here yet");
  check("in one line", (await page.locator(".bm-empty p").textContent()) === "Ask Pip anything, or to put work in a task.");
  check("a bot with no tasks has no fold", (await page.locator('.bm-fold[data-fold="pip"]').count()) === 0);
  await page.close();
}

// The rail: pictures only, and the open bot's tasks behind the header's Tasks button.
{
  const page = await open({ side: "rail", bot: "marlow" });
  check("the rail lists no task rows", (await page.locator(".bm-task:visible").count()) === 0);
  const button = page.getByRole("button", { name: "Marlow's tasks, 3" });
  check("the header has a Tasks button in the rail", (await button.count()) === 1);
  await button.click();
  const items = page.getByRole("menuitemradio");
  check("its menu lists the main conversation first, then each task", (await items.count()) === 4);
  check("the main conversation is checked", (await items.first().getAttribute("aria-checked")) === "true");
  await items.nth(1).click();
  check("a task opens from it", (await page.locator(".bm-pill-task").textContent()) === "Trail apps compared");
  await page.close();
  const wide = await open({ side: "wide", bot: "marlow" });
  check("no Tasks button while the sidebar lists the tasks", (await wide.locator(".bm-tasks-button").count()) === 0);
  await wide.close();
}

// Phone: one pane; the bot opens its main conversation, Back returns to the list.
{
  const page = await open({ bot: "marlow", pane: "list" }, "phone");
  check("phone: the list is shown", await page.locator(".bm-side").isVisible());
  await page.locator('.bm-bot[data-bot="juniper"]').click();
  check("phone: a bot opens its main conversation", (await page.locator(".bm-pill-name").textContent()) === "Juniper");
  await page.getByRole("button", { name: "Back to bots" }).click();
  check("phone: Back shows the list with the bot's tasks under it", (await page.locator('.bm-task[data-bot="juniper"]:visible').count()) === 2);
  check("phone: no sideways scroll in the list", await noSideways(page));
  await page.close();
  const main = await open({ bot: "marlow", pane: "conversation" }, "phone");
  check("phone: the main conversation's cards and composer fit", await noSideways(main));
  await main.close();
}

// The rail hides task rows: Down skips them, and the picture carries an unread task's mark.
{
  const page = await open({ side: "rail", bot: "marlow" });
  await page.locator('.bm-bot[data-bot="marlow"]').focus();
  await page.keyboard.press("ArrowDown");
  check(
    "rail: Down goes from a bot to the next bot, past hidden task rows",
    await page.evaluate(() => document.activeElement?.dataset.bot === "otto"),
  );
  check(
    "rail: the open bot's picture has the unread mark of a task it hides",
    (await page.locator('.bm-bot[data-bot="marlow"]').getAttribute("data-unread")) !== null,
  );
  await page.locator('.bm-bot[data-bot="marlow"]').click();
  await page.getByRole("button", { name: "Marlow's tasks, 3" }).click();
  await page.getByRole("menuitemradio", { name: /^Newsletter intro/ }).click();
  check(
    "rail: no unread mark for the task that is on screen",
    (await page.locator('.bm-bot[data-bot="marlow"]').getAttribute("data-unread")) === null,
  );
  await page.close();
}

// At phone width the list is full width, whatever the side: its task rows show.
{
  const page = await open({ side: "rail", bot: "marlow", pane: "list" }, "phone");
  check(
    "phone with side=rail: the open bot's task rows are shown",
    (await page.locator('.bm-task[data-bot="marlow"]:visible').count()) === 3,
  );
  check("phone with side=rail: folds are shown", (await page.locator(".bm-fold:visible").count()) === 3);
  await page.close();
}

// Marlow's started tasks are Marlow's: another bot opened after them draws its own conversation.
{
  const page = await open({ bot: "marlow", view: "started" });
  await page.locator('.bm-bot[data-bot="otto"]').click();
  check("after Marlow, Otto's main conversation is drawn", (await page.locator(".bm-pill-name").textContent()) === "Otto");
  check("and has no card of Marlow's", (await page.locator(".bm-card").count()) === 0);
  await page.close();
}

for (const side of ["wide", "narrow", "rail"]) {
  const page = await open({ side, bot: "marlow" });
  check(`${side}: no sideways scroll`, await noSideways(page));
  await page.close();
}

if (pictures) {
  mkdirSync(pictures, { recursive: true });
  const shots = [
    ["sidebar-wide", { side: "wide", bot: "marlow" }],
    ["sidebar-narrow", { side: "narrow", bot: "marlow" }],
    ["sidebar-rail", { side: "rail", bot: "marlow", menu: "tasks" }],
    ["bot-opened", { side: "wide", bot: "juniper" }],
    ["task-opened", { side: "wide", bot: "marlow", task: "trail" }],
    ["no-main-yet", { side: "wide", bot: "pip" }],
  ];
  for (const theme of ["dark", "light"]) {
    for (const [name, params] of shots) {
      if (theme === "light" && !["sidebar-wide", "task-opened"].includes(name)) continue;
      const page = await open({ ...params, theme });
      await page.screenshot({ path: join(pictures, `${name}-${theme}.png`) });
      await page.close();
    }
  }
  for (const [name, params] of [
    ["phone-list", { bot: "marlow", pane: "list" }],
    ["phone-main", { bot: "marlow", pane: "conversation" }],
  ]) {
    const page = await open(params, "phone");
    await page.screenshot({ path: join(pictures, `${name}-dark.png`) });
    await page.close();
  }
}

check("no page errors", errors.length === 0);
await browser.close();
console.log(`${count - failed} of ${count} checks passed`);
if (failed) process.exitCode = 1;
