// Checks prototype/main-bot.html against docs/design/main-bot-onboarding.md:
// the first run as a conversation, its words and structure, that nothing in it
// asks the person to read and approve, and that the rail and the header change
// only on the stand-in gateway's answer.
//
//   node docs/design/prototype/tools/checks/main-bot.mjs
import assert from "node:assert/strict";
import { chromium, pageUrl } from "./browser.mjs";

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
    await send(page, "Maple");
    // Before the stand-in answers, nothing has changed.
    assert.equal(await title(page), "Clawtrate Main Bot");
    if (width !== "phone")
      assert.equal(await railName(page, "clawtrate-main-bot", width), "Clawtrate Main Bot");
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
  await page.getByText("Back to Clawtrate Main Bot").waitFor();
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
    await has(page, ".mb-msg.is-bot", "what would you like to call me?");
  },
);

await check(
  "MB-08 a failed, slow, unconfirmed or taken opening, and a start from another bot, each say so plainly",
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

await browser.close();
console.log(`${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
