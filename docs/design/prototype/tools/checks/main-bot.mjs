// Checks prototype/main-bot.html against docs/design/main-bot-onboarding.md:
// the first run as a conversation, its words and structure, that nothing in it
// asks the person to read and approve, and that the rail and the header change
// only on the stand-in gateway's answer.
//
//   node docs/design/prototype/tools/checks/main-bot.mjs
//
// With `--pictures <folder>` it also writes section 15's pictures there.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, pageUrl } from "./browser.mjs";

const at = process.argv.indexOf("--pictures");
const pictures = at === -1 ? null : process.argv[at + 1];

const browser = await chromium.launch();
let failed = 0;
let passed = 0;

async function check(name, run) {
  for (const theme of ["dark", "light"]) {
    for (const width of ["full", "phone"]) {
      const page = await browser.newPage({
        viewport: width === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 },
      });
      const errors = [];
      const network = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) network.push(request.url());
      });
      await page.route(/^https?:/, (route) => route.abort());
      const open = async (query, motion = "reduce") => {
        await page.goto(
          `${pageUrl("main-bot.html")}?chrome=0&theme=${theme}&width=${width}&motion=${motion}&${query}`,
        );
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      };
      try {
        await run({ page, open, width });
        assert.deepEqual(errors, [], "no page errors");
        assert.deepEqual(network, [], "no network");
        passed += 1;
        console.log(`ok ${name} (${theme}, ${width})`);
      } catch (error) {
        failed += 1;
        console.log(`FAILED ${name} (${theme}, ${width}): ${error.message}`);
      }
      await page.close();
    }
  }
}

const text = (page, selector) => page.locator(selector).first().innerText();
const has = async (page, selector, words) =>
  assert.match(
    await text(page, selector),
    new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
const title = async (page) => (await page.getByTestId("title-name").innerText()).trim();
const railName = async (page, id, width) =>
  width === "phone" ? null : (await page.getByTestId(`rail-name-${id}`).innerText()).trim();
async function send(page, words) {
  await page.locator("#mb-input").fill(words);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
// Nothing in the first run stops the person to read and agree: no dialog, no
// form field but the composer, no Confirm, Approve, Rename or Not now.
async function noPrompt(page) {
  assert.equal(await page.getByRole("dialog").count(), 0, "no dialog");
  assert.equal(
    await page.locator("input, select, textarea:not(#mb-input)").count(),
    0,
    "no field but the composer",
  );
  for (const name of [
    "Confirm",
    "Approve",
    "Rename",
    "Not now",
    "Save in Clawtrate",
    "Review and save",
  ])
    assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0, `no ${name}`);
}

await check(
  "MB-01 the first thing after connecting is the bot's hello; the brief is a quiet line, never the person's",
  async ({ page, open }) => {
    await open("");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.equal(
      await page.locator(".mb-msg.is-user").count(),
      0,
      "no message in the person's name",
    );
    await has(page, ".mb-msg.is-bot", "what would you like to call me?");
    await has(page, '[data-testid="brief-line"]', "Clawtrate started this conversation");
    assert.equal(await page.getByTestId("brief-text").isHidden(), true);
    await page.getByRole("button", { name: "Show" }).click();
    await has(
      page,
      '[data-testid="brief-text"]',
      "[Clawtrate] Clawtrate made you a moment ago as this person's Main Bot",
    );
    assert.equal(
      await page.getByRole("button", { name: "Hide" }).getAttribute("aria-expanded"),
      "true",
    );
    assert.equal(await page.locator("#mb-input").inputValue(), "");
    assert.equal(await page.getByTestId("skip").count(), 1);
    await noPrompt(page);
  },
);

await check(
  "MB-02 the answer names the bot at once, on the read-back, with Undo",
  async ({ page, open, width }) => {
    await open("", "full");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.equal(await title(page), "Clawtrate Main Bot");
    // The stand-in's answer is held, so nothing can have read back yet.
    await page.evaluate(() => (window.mbHold = true));
    await send(page, "Maple");
    assert.equal(await title(page), "Clawtrate Main Bot");
    if (width !== "phone")
      assert.equal(await railName(page, "clawtrate-main-bot", width), "Clawtrate Main Bot");
    assert.equal(await page.getByTestId("named-line").count(), 0);
    await page.evaluate(() => (window.mbHold = false));
    await page.getByTestId("named-line").waitFor();
    await has(page, '[data-testid="named-line"]', "Renamed to Maple");
    assert.equal(await title(page), "Maple");
    if (width !== "phone") assert.equal(await railName(page, "clawtrate-main-bot", width), "Maple");
    assert.equal(await page.locator("#mb-input").getAttribute("placeholder"), "Message Maple");
    assert.match(
      await page.getByTestId("title-pill").getAttribute("aria-label"),
      /^Maple, Main Bot$/,
    );
    await page.getByText("What would you like a hand with?").waitFor();
    await page.waitForFunction(
      () => document.getElementById("mb-live").textContent === "Renamed to Maple",
    );
    await noPrompt(page);
  },
);

await check("MB-03 Undo puts the name back, on the read-back", async ({ page, open, width }) => {
  await open("at=named");
  await page.getByTestId("named-line").waitFor();
  await page.getByTestId("named-line").getByRole("button", { name: "Undo" }).click();
  await page
    .getByTestId("named-line")
    .filter({ hasText: "Back to Clawtrate Main Bot" })
    .waitFor();
  assert.equal(await title(page), "Clawtrate Main Bot");
  if (width !== "phone")
    assert.equal(await railName(page, "clawtrate-main-bot", width), "Clawtrate Main Bot");
  assert.equal(
    await page.getByTestId("named-line").getByRole("button", { name: "Undo" }).count(),
    0,
  );
});

await check(
  "MB-04 a name the person didn't type is still taken, and never shown as theirs",
  async ({ page, open }) => {
    await open("at=named&name=bot");
    await page.getByTestId("named-line").waitFor();
    await has(page, '[data-testid="named-line"]', "Clawtrate Main Bot renamed itself to Scout");
    assert.doesNotMatch(await text(page, '[data-testid="named-line"]'), /^Renamed to /);
    assert.equal(await title(page), "Scout");
    assert.equal(
      await page.getByTestId("named-line").getByRole("button", { name: "Undo" }).count(),
      1,
    );
    await noPrompt(page);
  },
);

await check(
  "MB-05 the tour shows by doing: a task under the bot's name, then its file",
  async ({ page, open, width }) => {
    await open("at=task");
    await page.getByTestId("card-task").waitFor();
    await has(page, '[data-testid="card-task"]', "Started a task");
    await has(page, '[data-testid="task-state"]', "Working");
    if (width !== "phone") await has(page, '[data-testid="rail-task"]', "Week checklist");
    await open("at=done");
    await page.getByTestId("card-file").waitFor();
    await has(page, '[data-testid="card-file"]', "week-checklist.md");
    await has(page, '[data-testid="task-state"]', "Done");
    if (width !== "phone") await has(page, '[data-testid="rail-task"]', "Done");
    await page.getByText("That's the tour.").waitFor();
    assert.equal(
      await page.getByTestId("skip").count(),
      0,
      "the skip button goes when the tour ends",
    );
    await page.getByTestId("card-file").getByRole("button", { name: "Save" }).click();
    assert.equal(
      await page.getByTestId("card-file").getByRole("button", { name: "Saved" }).count(),
      1,
    );
    await noPrompt(page);
  },
);

await check(
  "MB-06 Skip the tour sends the person's words and goes; nothing is lost",
  async ({ page, open }) => {
    await open("at=named");
    await page.getByText("What would you like a hand with?").waitFor();
    await page.getByTestId("skip").click();
    await page.getByText("Sure, no tour.").waitFor();
    assert.equal(
      await page.locator(".mb-msg.is-user").last().innerText(),
      "Let's skip the tour for now.",
    );
    assert.equal(await page.getByTestId("skip").count(), 0);
    assert.equal(await title(page), "Maple", "the name taken stays");
    // The conversation is the person's from here.
    await send(page, "What can you do?");
    await page.getByText("Happy to help.").waitFor();
  },
);

await check(
  "MB-07 no model account: Clawtrate's own message with the sign-ins comes before the hello",
  async ({ page, open }) => {
    await open("account=none");
    await page.getByTestId("account-step").waitFor();
    await has(
      page,
      '[data-testid="account-step"]',
      "Before your Main Bot can talk, it needs an account with a model provider.",
    );
    assert.equal(
      await page.getByRole("region", { name: "From Clawtrate" }).count(),
      1,
      "the message is Clawtrate's, not the bot's",
    );
    assert.equal(await page.locator(".mb-msg.is-bot").count(), 0, "the bot hasn't spoken");
    assert.equal(await page.getByTestId("brief-line").count(), 0, "nothing was sent to it yet");
    await page.getByRole("button", { name: "ChatGPT in the browser" }).click();
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await has(page, '[data-testid="account-step"]', "Signed in with ChatGPT in the browser.");
    // The Main Bot's model follows the account, before the opening goes.
    await has(page, '[data-testid="model-line"]', "Clawtrate Main Bot now runs on OpenAI");
    await has(page, ".mb-msg.is-bot", "what would you like to call me?");
  },
);

await check(
  "MB-08 a failed, slow, unconfirmed or taken opening, a model the account can't run, and a start from another bot, each say so plainly",
  async ({ page, open }) => {
    await open("opening=failed");
    await has(page, '[data-testid="failed-line"]', "The gateway couldn't run this message.");
    assert.equal(
      await page.locator(".mb-msg.is-bot").count(),
      0,
      "no empty wait: the line is there",
    );
    await page.getByRole("button", { name: "Try again" }).click();
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.equal(await page.getByTestId("failed-line").count(), 0);
    // A model the account can't run is never tried again: the next one it lists is.
    await open("opening=model");
    await has(
      page,
      '[data-testid="model-line"]',
      "Your account couldn't run GPT-5.5 Pro, so your Main Bot now uses GPT-5.5.",
    );
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.equal(await page.getByTestId("failed-line").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0);
    // None of its models runs: #686's line with its two ways, and no Try again.
    await open("opening=nomodel");
    await has(page, '[data-testid="failed-line"]', "The gateway couldn't run this message.");
    for (const name of ["Change model", "Change account"])
      assert.equal(await page.getByRole("button", { name }).count(), 1, name);
    assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 0);
    assert.equal(await page.locator(".mb-msg.is-bot").count(), 0);
    await open("slow=1");
    await has(page, '[data-testid="slow-line"]', "Your Main Bot hasn't answered yet.");
    assert.equal(
      await page.getByRole("button", { name: "Try again" }).count(),
      0,
      "a slow run has Stop, not Try again",
    );
    await page.getByRole("button", { name: "Stop" }).click();
    await has(page, '[data-testid="slow-line"]', "Stopped.");
    await open("opening=taken");
    await has(
      page,
      '[data-testid="opening-line"]',
      "Someone else wrote first in this conversation, so Clawtrate didn't send its first message.",
    );
    assert.equal(
      await page.getByTestId("brief-line").count(),
      0,
      "a row someone else wrote isn't drawn as Clawtrate's line",
    );
    await open("opening=unconfirmed");
    await has(
      page,
      '[data-testid="opening-line"]',
      "Clawtrate couldn't confirm your Main Bot got its first message. You can write to it yourself.",
    );
    for (const name of ["Send it again", "Leave it"])
      assert.equal(await page.getByRole("button", { name }).count(), 0, `no ${name}`);
    await open("from=juniper");
    await has(
      page,
      '[data-testid="from-line"]',
      "Clawtrate Main Bot started from what Juniper knows",
    );
    await has(page, '[data-testid="from-line"]', "2 skills stay with Juniper");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await has(page, ".mb-msg.is-bot", "Hi Sam!");
    await page.getByTestId("from-line").getByRole("button", { name: "Undo" }).click();
    await has(page, '[data-testid="from-line"]', "Juniper keeps all of it.");
    await noPrompt(page);
  },
);

await check(
  "MB-11 a device without full control: the conversation, and a plain line in place of the composer",
  async ({ page, open }) => {
    await open("device=limited&at=greeted");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await has(
      page,
      '[data-testid="limited-line"]',
      "You can write to your Main Bot here once it's set up.",
    );
    assert.equal(await page.locator("#mb-input").count(), 0);
    assert.equal(await page.getByTestId("skip").count(), 0);
  },
);

await check(
  "MB-12 the bring-in line names the bot as it is now, and follows its rename",
  async ({ page, open }) => {
    await open("from=juniper&at=named");
    await page.getByTestId("named-line").waitFor();
    await has(page, '[data-testid="from-line"]', "Maple started from what Juniper knows");
  },
);

await check(
  "MB-13 the tour follows the person: a typed skip, a second message while naming, the task started unasked, one Undo, Open task",
  async ({ page, open, width }) => {
    // A typed skip at the name question ends the tour; it doesn't become the name.
    await open("");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await send(page, "Skip the tour");
    await page.getByText("Sure, no tour.").waitFor();
    assert.equal(await title(page), "Clawtrate Main Bot");
    assert.equal(await page.getByTestId("skip").count(), 0);
    // A second message while the name is being taken waits, and is the help answer.
    await open("", "full");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await page.evaluate(() => (window.mbHold = true));
    await send(page, "Maple");
    await send(page, "I need help with code");
    await page.evaluate(() => (window.mbHold = false));
    // The help answer starts the task: the bot says it did, and asks for no yes.
    await page.getByTestId("card-task").waitFor();
    assert.equal(await title(page), "Maple");
    assert.match(
      await page.locator(".mb-transcript").innerText(),
      /I've started a task[\s\S]*stop or archive it there/,
    );
    assert.equal(await page.getByText("Want me to show you how I work here?").count(), 0);
    // A message sent while the help question is being written waits for it.
    // The stand-in is held the moment the rename line is drawn, so the help
    // question stays being written until the check releases it.
    await open("at=greeted");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await page.evaluate(() =>
      new MutationObserver((_, observer) => {
        if (!document.querySelector('[data-testid="named-line"]')) return;
        window.mbHold = true;
        observer.disconnect();
      }).observe(document.getElementById("mb-root"), { childList: true, subtree: true }),
    );
    await send(page, "Maple");
    await page.getByTestId("named-line").waitFor();
    await send(page, "I need help with code");
    assert.equal(await page.locator(".mb-status").count(), 1, "one reply being written");
    assert.equal(await page.getByTestId("card-task").count(), 0);
    await page.evaluate(() => (window.mbHold = false));
    await page.getByText("What would you like a hand with?").waitFor();
    await page.getByTestId("card-task").waitFor();
    // A Skip while the name is being taken: the name stays, no further tour
    // question, and a message written meanwhile is still answered.
    await open("", "full");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    await page.evaluate(() => (window.mbHold = true));
    await send(page, "Maple");
    await send(page, "I need help with code");
    await page.getByTestId("skip").click();
    await page.evaluate(() => (window.mbHold = false));
    await page.getByTestId("named-line").waitFor();
    await page.getByText("Happy to help. What would you like to do?").waitFor();
    assert.equal(await title(page), "Maple");
    assert.equal(await page.getByText("What would you like a hand with?").count(), 0);
    // Undo pressed twice changes the name back once.
    await open("at=named", "full");
    await page.getByTestId("named-line").waitFor();
    const undo = page.getByTestId("named-line").getByRole("button", { name: "Undo" });
    await page.evaluate(() => (window.mbHold = true));
    await undo.click();
    await undo.click();
    await page.evaluate(() => (window.mbHold = false));
    await page
      .getByTestId("named-line")
      .filter({ hasText: "Back to Clawtrate Main Bot" })
      .waitFor();
    assert.equal(await title(page), "Clawtrate Main Bot");
    // Open task opens the task.
    await open("at=task");
    await page.getByTestId("card-task").waitFor();
    await page.getByTestId("card-task").getByRole("button", { name: "Open task" }).click();
    await page.waitForFunction(
      () => document.getElementById("mb-live").textContent === "Opened Week checklist",
    );
    if (width !== "phone")
      assert.equal(await page.getByTestId("rail-task").getAttribute("aria-current"), "true");
    else {
      // On a phone the task takes the screen, and Back returns to the conversation.
      await has(page, '[data-testid="task-view"]', "started this task from Main");
      assert.equal(await page.getByTestId("transcript").count(), 0);
      await page.getByRole("button", { name: "Back to Maple" }).click();
      await page.getByTestId("card-task").waitFor();
    }
  },
);

await check(
  "MB-14 the page follows what happened: a finished first run, an undone bring-in, focus, a Skip before the hello or during the task",
  async ({ page, open }) => {
    // A device without full control has its composer once the first run is over.
    await open("device=limited&existing=1");
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.equal(await page.locator("#mb-input").count(), 1);
    // The greeting after an undone bring-in doesn't say it picked anything up.
    await open("from=juniper&opening=failed");
    await page.getByTestId("from-line").getByRole("button", { name: "Undo" }).click();
    await page.getByText("Removed what came from Juniper.").waitFor();
    await page.getByRole("button", { name: "Try again" }).click();
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.doesNotMatch(await text(page, ".mb-msg.is-bot"), /picked up what Juniper knew/);
    // Undo while the greeting is being written: it is chosen when it is posted.
    await open("from=juniper&opening=failed");
    await page.evaluate(() => (window.mbHold = true));
    await page.getByRole("button", { name: "Try again" }).click();
    await page.getByTestId("from-line").getByRole("button", { name: "Undo" }).click();
    await page.evaluate(() => (window.mbHold = false));
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.doesNotMatch(await text(page, ".mb-msg.is-bot"), /picked up what Juniper knew/);
    // Focus on Show stays there when the hello redraws the conversation.
    await open("", "full");
    await page.locator('[data-act="brief"]').focus();
    await page.locator(".mb-msg.is-bot").first().waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.dataset?.act), "brief");
    // A Skip before the hello: no answer is posted in the person's name.
    await open("at=done", "full");
    await page.getByTestId("skip").click();
    await page.getByText("Sure, no tour.").waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".mb-msg.is-user").count(), 1);
    // A Skip while the task works: its result and file still come, no wrap-up.
    await open("at=named", "full");
    await page.getByText("What would you like a hand with?").waitFor();
    await send(page, "Keeping my week organised");
    await page.getByTestId("card-task").waitFor();
    await page.getByTestId("skip").click();
    await page.getByTestId("card-file").waitFor();
    await page.waitForTimeout(1200);
    assert.equal(await page.getByText("That's the tour.").count(), 0);
  },
);

await check(
  "MB-09 a Main Bot made on another device: nothing is sent, and no tour",
  async ({ page, open }) => {
    await open("existing=1");
    assert.equal(await title(page), "Juniper");
    assert.equal(await page.getByTestId("brief-line").count(), 0);
    assert.equal(await page.locator(".mb-msg.is-user").count(), 0);
    assert.equal(await page.getByTestId("skip").count(), 0);
  },
);

await check(
  "MB-10 the keyboard reaches everything, and a screen reader hears what changed",
  async ({ page, open }) => {
    await open("at=named");
    await page.getByTestId("named-line").waitFor();
    await page.locator("#mb-input").focus();
    // From the composer, Shift+Tab goes back through Skip the tour.
    let reached = false;
    for (let i = 0; i < 12 && !reached; i += 1) {
      await page.keyboard.press("Shift+Tab");
      reached = await page.evaluate(() => document.activeElement?.dataset.testid === "skip");
    }
    assert(reached, "Skip the tour is reachable by keyboard");
    await page.keyboard.press("Enter");
    await page.getByText("Sure, no tour.").waitFor();
    await page.waitForFunction(
      () => document.getElementById("mb-live").textContent === "Tour skipped",
    );
    // Undo is a button with a name.
    assert.equal(
      await page.getByTestId("named-line").getByRole("button", { name: "Undo" }).count(),
      1,
    );
  },
);

await check(
  "MB-20 the Main Bot's tile comes first, with the gold star, and the gateway's own bot isn't listed",
  async ({ page, open, width }) => {
    for (const query of ["at=greeted", "existing=1"]) {
      await open(query);
      if (width === "phone") continue;
      const tile = page.getByTestId("main-tile");
      assert.equal(await tile.count(), 1);
      // The tile sits above the list of the other bots, and the Main Bot isn't a row too.
      const above = await page.evaluate(() => {
        const t = document.querySelector('[data-testid="main-tile"]').getBoundingClientRect();
        const l = document.querySelector(".mb-list").getBoundingClientRect();
        return t.bottom <= l.top + 1;
      });
      assert(above, "the tile is above the rows");
      assert.equal(await page.locator(".mb-list [data-bot='clawtrate-main-bot']").count(), 0);
      assert.match(await tile.getAttribute("aria-label"), /, Main Bot$/);
      assert.equal(await tile.locator(".mb-star").count(), 1);
      // The star is the gold token, not the accent.
      const fill = await tile
        .locator(".mb-star")
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const gold = await page.evaluate(() => {
        const probe = document.createElement("span");
        probe.style.color = "var(--star)";
        document.body.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      });
      assert.equal(fill, gold);
      // The gateway's own bot, `main`, is on the gateway but not in the rail; the person's bots are.
      assert.equal(await page.getByTestId("rail-name-main").count(), 0);
      assert.equal(await page.getByTestId("rail-name-pip").count(), 1);
    }
  },
);

await check(
  "MB-21 changing the Main Bot is offered only with Clawtrate's bot tools",
  async ({ page, open, width }) => {
    if (width === "phone") return;
    await open("existing=1");
    await page.getByRole("button", { name: "Juniper options" }).click();
    assert.equal(
      await page.getByRole("menuitem", { name: "Replace with different bot" }).count(),
      1,
    );
    await open("existing=1&plugin=missing");
    await page.getByRole("button", { name: "Juniper options" }).click();
    assert.equal(
      await page.getByRole("menuitem", { name: "Replace with different bot" }).count(),
      0,
    );
    await has(
      page,
      '[data-testid="main-menu-note"]',
      "Changing the Main Bot needs Clawtrate's bot tools on your gateway.",
    );
  },
);

// ---- section 15: a gateway the person brings ----

const QUIET_TIP =
  "Clawtrate made this bot on your gateway, with its own folder. Your other bots, chat apps and settings are as they were. To remove it, delete it in its settings.";

await check(
  "MB-22 a brought gateway: the same first run, with the gateway's own bot the person used listed beside it",
  async ({ page, open, width }) => {
    await open("gateway=brought&at=greeted");
    await page.getByText("what would you like to call me?").waitFor();
    await has(page, '[data-testid="brief-line"]', "Clawtrate started this conversation");
    await page.getByTestId("skip").waitFor();
    await noPrompt(page);
    if (width === "phone") {
      await open("gateway=brought&at=greeted&pane=list");
      // The list on a phone: the Main Bot's tile first, then the person's bots.
      const names = await page.locator(".mb-name").allInnerTexts();
      assert.deepEqual(names.slice(0, 2), ["Clawtrate Main Bot", "Juniper"]);
      await page.getByTestId("main-tile").click();
      await page.getByTestId("transcript").waitFor();
      return;
    }
    assert.equal(await railName(page, "main", width), "Juniper");
    // An ordinary row: never starred.
    assert.equal(await page.locator('[data-bot="main"] .mb-star').count(), 0);
    // An untouched one stays out, as before.
    await open("at=greeted");
    assert.equal(await page.getByTestId("rail-name-main").count(), 0);
  },
);

await check("MB-23 the quiet line's \"i\" says what Clawtrate added, on press", async ({ page, open }) => {
  await open("gateway=brought&at=start");
  const i = page.getByRole("button", { name: "What Clawtrate added" });
  assert.equal(await i.getAttribute("aria-expanded"), "false");
  assert.equal(await page.getByTestId("tip-quiet").isVisible(), false);
  await i.click();
  assert.equal(
    await page.getByRole("button", { name: "What Clawtrate added" }).getAttribute("aria-expanded"),
    "true",
  );
  assert.equal((await page.getByTestId("tip-quiet").innerText()).trim(), QUIET_TIP);
  assert.equal(
    await page.evaluate(() => document.activeElement?.dataset.tip),
    "quiet",
    "focus stays on the i",
  );
});

await check(
  "MB-24 someone who used Clawtrate here before: nothing sent, the tile offers Set up and Hide",
  async ({ page, open, width }) => {
    await open(`offer=1${width === "phone" ? "&pane=list" : ""}`);
    const tile = page.getByTestId("setup-tile");
    await tile.waitFor();
    assert.equal(await page.getByTestId("main-tile").count(), 0, "no Main Bot is made");
    assert.equal(await page.getByTestId("brief-line").count(), 0, "nothing is sent");
    assert.equal(await tile.getByRole("button", { name: "Set up", exact: true }).count(), 1);
    await tile.getByRole("button", { name: "Hide", exact: true }).click();
    assert.equal(await page.getByTestId("setup-tile").count(), 0);
    await page.waitForFunction(() => document.getElementById("mb-live").textContent === "Hidden");
    if (width === "phone") return;
    assert.equal(await railName(page, "main", width), "Juniper");
    // Set up runs the first run from the start.
    await open("offer=1");
    await page.getByRole("button", { name: "Set up", exact: true }).click();
    await page.getByTestId("main-tile").waitFor();
    await page.getByTestId("brief-line").waitFor();
    await page.getByText("what would you like to call me?").waitFor();
  },
);

await check(
  "MB-25 a gateway the steps don't fit: one line that the Main Bot is waiting, and Try again",
  async ({ page, open, width }) => {
    const words = {
      version: "Your Main Bot is waiting: this OpenClaw can't make one yet.",
      include:
        "Your Main Bot is waiting: OpenClaw won't add a bot while your channel settings are kept in a separate file.",
      refused: "Your Main Bot is waiting: OpenClaw didn't add it.",
    };
    for (const [reason, line] of Object.entries(words)) {
      await open(`waiting=${reason}${width === "phone" ? "&pane=list" : ""}`);
      assert.equal(
        (await page.getByTestId("setup-line").innerText()).replace(/\s*i$/, "").trim(),
        line,
      );
      assert.equal(await page.getByRole("button", { name: "Try again" }).count(), 1);
      assert.equal(await page.getByTestId("main-tile").count(), 0);
      assert.equal(await page.getByRole("link").count(), 0, "no link out");
    }
    await open(`waiting=include${width === "phone" ? "&pane=list" : ""}`);
    await page.getByRole("button", { name: "Why" }).click();
    assert.equal(
      (await page.getByTestId("tip-waiting").innerText()).trim(),
      "OpenClaw adds a second bot only where it can record which bot your chat apps reach, and it doesn't write that file.",
    );
  },
);

await check(
  "MB-26 no full control: the person's bots as they are, and the one request",
  async ({ page, open, width }) => {
    await open(`device=readonly${width === "phone" ? "&pane=list" : ""}`);
    assert.equal(
      (await page.getByTestId("setup-line").innerText()).trim(),
      "Clawtrate needs full control of your gateway to make your Main Bot.",
    );
    assert.equal(await page.getByRole("button", { name: "Give full control" }).count(), 1);
    assert.equal(await page.getByTestId("rail-name-main").innerText(), "Juniper");
  },
);

await check("MB-27 #799: the Main Bot's model added to the allowlist, with Undo", async ({ page, open }) => {
  await open("gateway=brought&at=start&allowlist=1");
  const line = page.getByTestId("allow-line");
  await has(page, '[data-testid="allow-line"]', "Added GPT-5.5 to the models this gateway allows");
  await line.getByRole("button", { name: "Undo" }).click();
  await has(page, '[data-testid="allow-line"]', "Removed GPT-5.5 from the models this gateway allows");
});

if (pictures) {
  mkdirSync(pictures, { recursive: true });
  const shoot = async (name, query, phone, act) => {
    const page = await browser.newPage({
      viewport: phone ? { width: 390, height: 844 } : { width: 1100, height: 720 },
    });
    await page.route(/^https?:/, (route) => route.abort());
    await page.goto(
      `${pageUrl("main-bot.html")}?chrome=0&motion=reduce${phone ? "&width=phone" : ""}&${query}`,
    );
    await page.evaluate(() => document.fonts.ready);
    if (act) await act(page);
    await page.screenshot({ path: join(pictures, `${name}.png`) });
    await page.close();
  };
  const greeted = (page) => page.getByText("what would you like to call me?").waitFor();
  for (const theme of ["dark", "light"]) {
    await shoot(`brought-desktop-${theme}`, `theme=${theme}&gateway=brought&at=greeted`, false, greeted);
    await shoot(`offer-desktop-${theme}`, `theme=${theme}&offer=1`);
  }
  await shoot("brought-phone-dark", "theme=dark&gateway=brought&at=greeted&pane=list", true, (page) =>
    page.getByTestId("main-tile").waitFor(),
  );
  await shoot("brought-info-desktop-dark", "theme=dark&gateway=brought&at=greeted&info=1&allowlist=1", false, greeted);
  await shoot("offer-phone-dark", "theme=dark&offer=1&pane=list", true);
  await shoot("waiting-desktop-dark", "theme=dark&waiting=include", false, (page) =>
    page.getByRole("button", { name: "Why" }).click(),
  );
  await shoot("waiting-phone-dark", "theme=dark&waiting=version&pane=list", true);
  await shoot("no-full-control-desktop-dark", "theme=dark&device=readonly");
  await shoot("skipped-desktop-dark", "theme=dark&gateway=brought&at=greeted", false, async (page) => {
    await greeted(page);
    await page.getByTestId("skip").click();
    await page.getByText("Sure, no tour.").waitFor();
  });
}

await browser.close();
console.log(`${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
