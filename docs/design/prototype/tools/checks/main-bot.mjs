// Checks prototype/main-bot.html against docs/design/main-bot-onboarding.md:
// each state's words and structure, and that the rail and the header change
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
      const page = await browser.newPage({ viewport: width === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 900 } });
      const errors = [];
      const network = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (/^https?:/.test(request.url())) network.push(request.url());
      });
      await page.route(/^https?:/, (route) => route.abort());
      const open = async (query, motion = "reduce") => {
        await page.goto(`${pageUrl("main-bot.html")}?chrome=0&theme=${theme}&width=${width}&motion=${motion}&${query}`);
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
const has = async (page, selector, words) => assert.match(await text(page, selector), new RegExp(words.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
const focusIn = (page, selector) => page.evaluate((sel) => Boolean(document.activeElement?.closest(sel)), selector);
async function staysIn(page, selector) {
  for (const key of ["Tab", "Tab", "Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    assert(await focusIn(page, selector), `focus stays in ${selector} after ${key}`);
  }
}
const railName = async (page, id, width) =>
  width === "phone" ? null : (await page.getByTestId(`rail-name-${id}`).innerText()).trim();

await check("MB-01 the autonomy step: two cards about commands, nothing chosen, both lines", async ({ page, open }) => {
  await open("view=setup");
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "How should bots run commands?");
  const radios = page.getByRole("radiogroup").getByRole("radio");
  assert.equal(await radios.count(), 2);
  await has(page, '[data-choose="hands-off"]', "Run commands without routine approvals, where this computer allows it.");
  await has(page, '[data-choose="ask"]', "Ask when a host command doesn't match an existing rule.");
  assert.deepEqual(await radios.evaluateAll((r) => r.map((x) => x.getAttribute("aria-checked"))), ["false", "false"]);
  await has(page, '[data-testid="settings-line"]', "a bot asks you before it changes its own or another bot's settings");
  await has(page, '[data-testid="limits-line"]', "Clawtrate's limits cover changes made through Clawtrate.");
});

await check("MB-02 What this means: rule matches, the fallback, stop isn't undo", async ({ page, open }) => {
  await open("view=setup");
  await page.getByRole("button", { name: "What this means" }).click();
  assert.equal(await page.getByRole("dialog", { name: "What this means" }).count(), 1);
  await has(page, '[data-testid="sheet"]', "including rules you didn't add yourself");
  await has(page, '[data-testid="sheet"]', "unless this computer's or the task's own rules decide first");
  await has(page, '[data-testid="sheet"]', "If nobody answers in 30 minutes, the computer's own fallback decides");
  await has(page, '[data-testid="sheet"]', "It doesn't undo a command that already ran.");
  // The setup behind is inert, and Tab and Shift+Tab stay in the sheet.
  assert.equal(await page.locator(".mb-setup-card").getAttribute("inert"), "");
  const inSheet = () => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="sheet"]')));
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    assert(await inSheet(), `focus stays in the sheet after ${key}`);
  }
  const onOpener = () => page.evaluate(() => document.activeElement?.dataset.testid === "what-this-means");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("sheet").count(), 0);
  assert(await onOpener(), "Escape returns focus to What this means");
  assert.equal(await page.locator(".mb-setup-card").getAttribute("inert"), null);
  await page.getByRole("button", { name: "What this means" }).click();
  await page.getByRole("button", { name: "Done" }).click();
  assert(await onOpener(), "Done returns focus to What this means");
});

await check("MB-03 an existing Main Bot: its policy named, nothing inferred, opt-in to change it", async ({ page, open }) => {
  await open("view=setup&existing=1");
  await has(page, '[data-testid="existing-line"]', "Juniper has its own command settings: Ask before acting.");
  assert.deepEqual(await page.getByRole("radio").evaluateAll((r) => r.map((x) => x.getAttribute("aria-checked"))), ["false", "false"]);
  assert.equal(await page.getByLabel("Also use this for Juniper").isChecked(), false);

  // Through to chat: Juniper is kept, nothing is sent for the person, and only
  // the opt-in changes Juniper's own policy. The opt-in survives the sheet.
  for (const also of [false, true]) {
    await open("view=setup&existing=1");
    if (also) {
      await page.getByLabel("Also use this for Juniper").check();
      await page.getByRole("button", { name: "What this means" }).click();
      await page.keyboard.press("Escape");
      assert.equal(await page.getByLabel("Also use this for Juniper").isChecked(), true);
    }
    await page.getByRole("radio", { name: /Hands-off/ }).click();
    await page.getByTestId("existing-main").waitFor();
    assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Juniper");
    assert.equal(await page.locator(".mb-msg.is-user").count(), 0);
    assert.equal(await page.getByTestId("guided").count(), 0);
    await has(page, '[data-testid="autonomy-line"]', `New bots: Hands-off. Juniper: ${also ? "Hands-off" : "Ask before acting"}.`);
  }
});

await check("MB-04 choosing opens the first run: opening, greeting, guided card, empty composer", async ({ page, open }) => {
  await open("view=setup");
  await page.getByRole("radio", { name: /Hands-off/ }).click();
  await page.getByTestId("guided").waitFor();
  await has(page, '[data-testid="opening-caption"]', "Sent for you when setup finished.");
  await has(page, ".mb-msg.is-user", "What should I call you, and how can you help me?");
  assert.equal(await page.locator("#mb-input").inputValue(), "");
  assert.equal(await page.locator("#g-name").inputValue(), "");
  await has(page, '[data-testid="guided"]', "Saves this name and role. Clawtrate shows them once the gateway confirms.");

  // The composer is usable while the first reply is still pending.
  await page.clock.install({ time: new Date("2030-01-01T09:00:00Z") });
  await page.clock.pauseAt(new Date("2030-01-01T09:00:01Z"));
  await open("view=first", "full");
  const early = "I have a question while you get started.";
  await page.locator("#mb-input").fill(early);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.clock.runFor(1200);
  await page.getByTestId("guided").waitFor();
  assert.equal(await page.locator(".mb-msg.is-user").getByText(early, { exact: true }).count(), 1);
  assert.equal(await page.locator(".mb-status").count(), 0);
});

await check("MB-20 the Main Bot's tile comes first, with the gold star, and the gateway's own bot isn't listed", async ({ page, open, width }) => {
  for (const query of ["view=first&at=greeted", "view=first&existing=1"]) {
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
    const fill = await tile.locator(".mb-star").evaluate((el) => getComputedStyle(el).backgroundColor);
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
});

await check("MB-21 changing the Main Bot is offered only with Clawtrate's bot tools", async ({ page, open, width }) => {
  if (width === "phone") return;
  await open("view=first&existing=1");
  await page.getByRole("button", { name: "Juniper options" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Replace with different bot" }).count(), 1);
  await open("view=first&existing=1&plugin=missing");
  await page.getByRole("button", { name: "Juniper options" }).click();
  assert.equal(await page.getByRole("menuitem", { name: "Replace with different bot" }).count(), 0);
  await has(page, '[data-testid="main-menu-note"]', "Changing the Main Bot needs Clawtrate's bot tools on your gateway.");
});

await check("MB-05 Save without a name writes nothing", async ({ page, open }) => {
  await open("view=first");
  await page.getByTestId("guided").getByRole("button", { name: "Save" }).click();
  await has(page, '[data-testid="guided-problem"]', "Give your Main Bot a name first.");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Clawtrate Main Bot");
});

await check("MB-06 the rail and header wait for the gateway's answer", async ({ page, open, width }) => {
  await open("view=first&at=saving");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Clawtrate Main Bot");
  if (width !== "phone") assert.equal(await railName(page, "clawtrate-main-bot", width), "Clawtrate Main Bot");
  await has(page, '[data-testid="guided"]', "Saving…");

  const name = page.locator("#g-name");
  const role = page.locator("#g-role");
  const submittedRole = await role.inputValue();
  assert(await name.isDisabled());
  const message = "Call yourself Basil. Help me plan the garden.";
  await page.locator("#mb-input").fill(message);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  assert.equal(await page.locator(".mb-msg.is-user").getByText(message, { exact: true }).count(), 1);
  assert.equal(await name.inputValue(), "Maple");
  assert.equal(await role.inputValue(), submittedRole);
  assert.equal(await page.getByTestId("proposed-note").count(), 0);
});

await check("MB-07 Save writes exactly the card's name and role, read back; the Claw is a separate explicit edit", async ({ page, open, width }) => {
  await open("view=first");
  await page.locator("#g-name").fill("  Fennel   Bulb ");
  await has(page, '[data-testid="stored-as"]', "Saved as “Fennel Bulb”");
  await page.locator("#g-role").fill("Help me plan the garden.");
  await page.getByTestId("guided").getByRole("button", { name: "Save" }).click();
  await page.getByTestId("guided-saved").waitFor();
  assert.equal((await page.getByTestId("saved-name").innerText()).trim(), "Fennel Bulb");
  assert.equal((await page.getByTestId("saved-role").innerText()).trim(), "Help me plan the garden.");
  assert.doesNotMatch(await text(page, '[data-testid="guided-saved"]'), /Claw/);
  assert.doesNotMatch(await text(page, ".mb-transcript"), /meals/);
  assert.equal(await page.getByTestId("title-pill").getAttribute("data-picture"), "none");
  await has(page, '[data-testid="card-picture-offer"]', "If someone sets a picture elsewhere at the same moment, this replaces it.");
  await page.getByRole("button", { name: "Use Fennel Bulb's Claw" }).click();
  await page.getByText("Fennel Bulb's picture is its Claw").waitFor();
  assert.equal(await page.getByTestId("title-pill").getAttribute("data-picture"), "claw");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Fennel Bulb");
  if (width !== "phone") assert.equal(await railName(page, "clawtrate-main-bot", width), "Fennel Bulb");
  assert.equal(await page.getByTestId("title-pill").getAttribute("aria-label"), "Fennel Bulb, Main Bot");
  await has(page, ".mb-transcript", "Call yourself Fennel Bulb. Help me plan the garden.");
});

await check("MB-08 unconfirmed and stale saves leave the name and say why", async ({ page, open }) => {
  await open("view=first&card=unconfirmed");
  await page.getByTestId("guided-problem").waitFor();
  await has(page, '[data-testid="guided-problem"]', "Clawtrate couldn't confirm whether this changed.");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Clawtrate Main Bot");
  await open("view=first&card=stale");
  await page.getByTestId("guided-problem").waitFor();
  await has(page, '[data-testid="guided-problem"]', "so nothing was saved");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Clawtrate Main Bot");
});

await check("MB-09 no Apply and no Undo on any card: proposals are saved in the person's own editor", async ({ page, open }) => {
  for (const view of ["view=first&at=done", "view=rename", "view=rename&at=done", "view=create", "view=create&at=done", "view=proposal"]) {
    await open(view);
    await page.locator(".mb-card").first().waitFor();
    const names = await page.locator(".mb-card button").allInnerTexts();
    assert(!names.some((n) => /^(Apply|Undo)\b/.test(n.trim())), `${view}: ${names.join(", ")}`);
  }
});

await check("MB-10 an existing Main Bot: nothing sent for the person", async ({ page, open }) => {
  await open("view=first&existing=1");
  await has(page, '[data-testid="existing-main"]', "Juniper is your Main Bot.");
  assert.equal(await page.locator(".mb-msg.is-user").count(), 0);
  assert.equal(await page.getByTestId("guided").count(), 0);
});

await check("MB-11 the plugin missing: Save in Clawtrate, and the line", async ({ page, open }) => {
  await open("view=first&plugin=missing");
  await has(page, '[data-testid="plugin-missing"]', "bots can't ask to change their settings");
  assert.equal(await page.getByTestId("guided").getByRole("button", { name: "Save in Clawtrate" }).count(), 1);

  // No bot tool fills the card; the person's own Save still works.
  await page.locator("#mb-input").fill("Call yourself Basil. Help me plan the garden.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Put that in the card, then press Save in Clawtrate.").waitFor();
  assert.equal(await page.locator("#g-name").inputValue(), "");
  assert.equal(await page.getByTestId("proposed-note").count(), 0);
  await page.locator("#g-name").fill("Basil");
  await page.locator("#g-role").fill("Help me plan the garden.");
  await page.getByRole("button", { name: "Save in Clawtrate" }).click();
  await page.getByTestId("guided-saved").waitFor();
  assert.equal((await page.getByTestId("saved-name").innerText()).trim(), "Basil");
  assert.equal((await page.getByTestId("saved-role").innerText()).trim(), "Help me plan the garden.");
  assert.equal(await page.getByTestId("card-picture-offer").count(), 0);
});

await check("MB-12 a bot's own rename is a proposal; Review and save opens the person's editor; the rename is the person's", async ({ page, open, width }) => {
  await open("view=rename");
  const card = page.getByTestId("card-proposal");
  await has(page, '[data-testid="card-proposal"]', "Pip asks to rename itself Scout");
  await has(page, '[data-testid="card-proposal"]', "Clawtrate can't apply this for you on this gateway. Review and save opens your editor with these values.");
  assert.deepEqual(await card.getByRole("button").allInnerTexts(), ["Review and save", "Rename Pip to Scout", "Not now"]);
  await card.getByRole("button", { name: "Review and save" }).click();
  const editor = page.getByRole("dialog", { name: "Pip's instructions" });
  await editor.waitFor();
  await has(page, '[data-testid="editor"]', "Clawtrate read Pip's instructions again when this opened.");
  assert.match(await page.locator("#ed-0").inputValue(), /Keep answers short/);
  if (width !== "phone") assert.equal(await railName(page, "pip", width), "Pip");
  // A real modal: the chat behind is inert, focus stays in, and Escape and
  // Cancel give it back to Review and save.
  assert.equal(await page.locator(".mb-shell").getAttribute("inert"), "");
  await staysIn(page, '[data-testid="editor"]');
  const onReview = () => page.evaluate(() => document.activeElement?.dataset.act === "review" && document.activeElement.closest("article")?.dataset.id === "scout");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("editor").count(), 0);
  assert(await onReview(), "Escape returns focus to Review and save");
  assert.equal(await page.locator(".mb-shell").getAttribute("inert"), null);
  await card.getByRole("button", { name: "Review and save" }).click();
  await editor.getByRole("button", { name: "Cancel" }).click();
  assert(await onReview(), "Cancel returns focus to Review and save");
  // Save stores what the editor holds.
  await card.getByRole("button", { name: "Review and save" }).click();
  await page.locator("#ed-0").fill("Plan errands and trips.\nAnswer in three lines at most.");
  await editor.getByRole("button", { name: "Save" }).click();
  await page.getByTestId("card-saved").waitFor();
  await has(page, '[data-testid="card-saved"]', "Saved by you in Pip's instructions.");
  await has(page, '[data-testid="card-saved"]', "Answer in three lines at most.");
  assert.doesNotMatch(await text(page, '[data-testid="card-saved"]'), /use a list/);
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Pip");
  await page.getByRole("button", { name: "Rename Pip to Scout" }).click();
  await page.getByTestId("own-rename-line").waitFor();
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Scout");
  if (width !== "phone") assert.equal(await railName(page, "pip", width), "Scout");

  await open("view=rename");
  await page.getByRole("button", { name: "Rename Pip to Scout" }).click();
  await page.getByTestId("own-rename-line").waitFor();
  await page.getByRole("button", { name: "Not now" }).click();
  await has(page, '[data-testid="card-declined"]', "Kept Scout's instructions");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Scout");

  // Renamed first, then reviewed and saved: the editor and the receipt use
  // the bot's current name.
  await open("view=rename");
  await page.getByRole("button", { name: "Rename Pip to Scout" }).click();
  await page.getByTestId("own-rename-line").waitFor();
  await page.getByRole("button", { name: "Review and save" }).click();
  const renamed = page.getByRole("dialog", { name: "Scout's instructions" });
  await renamed.waitFor();
  await has(page, '[data-testid="editor"]', "Clawtrate read Scout's instructions again when this opened.");
  await renamed.getByRole("button", { name: "Save" }).click();
  await page.getByTestId("card-saved").waitFor();
  await has(page, '[data-testid="card-saved"]', "Scout's instructions changed");
  await has(page, '[data-testid="card-saved"]', "Saved by you in Scout's instructions.");
  assert.doesNotMatch(await text(page, '[data-testid="card-saved"]'), /Pip/);
});

await check("MB-13 a changed bot starts the editor from what it says now; Not now keeps everything; Cancel writes nothing", async ({ page, open }) => {
  await open("view=rename&card=stale");
  await page.getByTestId("editor-stale").waitFor();
  await has(page, '[data-testid="editor-stale"]', "Pip's instructions changed since Pip asked.");
  const now = await page.locator("#ed-0").inputValue();
  assert.match(now, /Check the weather before outdoor errands\./, "starts from what Pip's instructions say now");
  assert.match(now, /Keep answers short/, "with Pip's change added");
  await page.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await page.getByTestId("editor").count(), 0);
  assert.equal(await page.getByTestId("card-proposal").count(), 1);
  await page.getByRole("button", { name: "Review and save" }).click();
  await page.locator("#ed-0").fill(`${now}\nSkip the hardware store on Sundays.`);
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.getByTestId("card-saved").waitFor();
  await has(page, '[data-testid="card-saved"]', "Check the weather before outdoor errands.");
  await has(page, '[data-testid="card-saved"]', "Skip the hardware store on Sundays.");
  await open("view=rename&card=declined");
  await has(page, '[data-testid="card-declined"]', "Kept Pip's instructions");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Pip");
});

await check("MB-14 the star grants nothing: a manager grant comes first", async ({ page, open }) => {
  await open("view=create&grant=0");
  await has(page, '[data-testid="card-grant"]', "Juniper can't ask to change other bots");
  await has(page, '[data-testid="card-grant"]', "Being your Main Bot doesn't include this.");
  assert.equal(await page.getByTestId("card-proposal").count(), 0);
  await page.getByRole("button", { name: "Allow" }).click();
  await page.getByTestId("card-proposal").waitFor();
});

await check("MB-15 creating by chat: every value shown, the follow-ons gated, New bot filled, listed after the read-back", async ({ page, open, width }) => {
  await open("view=create");
  await has(page, '[data-testid="card-proposal"]', "Juniper asks to create Stride");
  await has(page, '[data-testid="card-proposal"]', "More freedom than your usual choice");
  await has(page, '[data-testid="card-proposal"]', "Clawtrate can't create this for you on this gateway");
  assert.equal(await page.locator('[data-testid="card-proposal"] [data-gated="1"]').count(), 3);
  if (width !== "phone") assert.equal(await page.getByTestId("rail-name-stride").count(), 0);
  await page.getByRole("button", { name: "Review and save" }).click();
  const dialog = page.getByRole("dialog", { name: "New bot" });
  await dialog.waitFor();
  assert.equal(await page.locator("#ed-0").inputValue(), "Stride");
  assert.equal(await page.locator("#ed-2").inputValue(), "Hands-off");
  // A refused draft is kept as the person left it, with focus on the name.
  await page.locator("#ed-3").fill("Plans my tempo runs.");
  await page.locator("#ed-2").selectOption("Ask before acting");
  await page.locator("#ed-0").fill(" ");
  await dialog.getByRole("button", { name: "Create" }).click();
  await has(page, '[data-testid="editor-problem"]', "Give the new bot a name first.");
  assert.equal(await page.locator("#ed-3").inputValue(), "Plans my tempo runs.");
  assert.equal(await page.locator("#ed-2").inputValue(), "Ask before acting");
  assert.equal(await page.locator("#ed-0").inputValue(), " ");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ed-0");
  if (width !== "phone") assert.equal(await page.getByTestId("rail-name-stride").count(), 0);
  // An existing id is refused (R28): Pip's row stays, and the draft comes back.
  await page.locator("#ed-0").fill("Pip");
  await dialog.getByRole("button", { name: "Create" }).click();
  await has(page, '[data-testid="editor-problem"]', "There's already a bot with the id pip, so nothing was created.");
  assert.equal(await page.locator("#ed-0").inputValue(), "Pip");
  assert.equal(await page.locator("#ed-3").inputValue(), "Plans my tempo runs.");
  assert.equal(await page.locator("#ed-2").inputValue(), "Ask before acting");
  assert.equal(await page.getByTestId("card-saved").count(), 0);
  if (width !== "phone") assert.equal(await page.getByTestId("rail-name-pip").count(), 1);
  // A fresh name succeeds, with what the person left in New bot.
  await page.locator("#ed-0").fill("Tempo");
  await dialog.getByRole("button", { name: "Create" }).click();
  await page.getByTestId("card-saved").waitFor();
  await has(page, '[data-testid="card-saved"]', "Created by you in New bot.");
  await has(page, '[data-testid="card-saved"]', "Created Tempo");
  await has(page, '[data-testid="card-saved"]', "Ask before acting");
  await has(page, '[data-testid="card-saved"]', "Plans my tempo runs.");
  assert.doesNotMatch(await text(page, '[data-testid="card-saved"]'), /Stride|Hands-off/);
  if (width !== "phone") {
    assert.equal(await railName(page, "tempo", width), "Tempo");
    assert.equal(await page.getByTestId("rail-name-stride").count(), 0);
  }
});

await check("MB-16 other origins: unconfirmed origin, a name only the person changes, another bot's diff, more freedom", async ({ page, open, width }) => {
  await open("view=proposal");
  await has(page, '[data-testid="channel-note"]', "direct messages from your connected chat apps");
  assert.equal(await page.getByTestId("card-proposal").count(), 3);
  await has(page, '[data-id="junebug"]', "Clawtrate couldn't confirm where this request came from.");
  assert.deepEqual(await page.locator('[data-id="junebug"]').getByRole("button").allInnerTexts(), ["Rename Juniper to Junebug", "Not now"]);
  await has(page, '[data-id="otto-instructions"]', "Another bot's instructions");
  assert.equal(await page.locator('[data-id="otto-instructions"] .mb-diff [data-sign="+"]').count(), 2);
  await has(page, '[data-id="pip-freedom"]', "More freedom");
  if (width !== "phone") assert.equal(await page.getByTestId("proposals-count").innerText(), "3");
  // A select-only editor still takes focus, so Escape works at once.
  await page.locator('[data-id="pip-freedom"]').getByRole("button", { name: "Review and save" }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ed-0");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("editor").count(), 0);
  await page.locator('[data-id="pip-freedom"]').getByRole("button", { name: "Review and save" }).click();
  await has(page, '[data-testid="editor"]', "This gives Pip more freedom.");
  await page.locator("#ed-0").selectOption("Ask before acting");
  await page.getByRole("dialog").getByRole("button", { name: "Save" }).click();
  await page.locator('[data-id="pip-freedom"][data-kind="saved"]').waitFor();
  await has(page, '[data-id="pip-freedom"]', "Pip asks before acting");
  assert.doesNotMatch(await text(page, '[data-id="pip-freedom"]'), /Hands-off/);
  assert.equal(await page.locator('[data-id="pip-freedom"]').getByRole("button").count(), 0);

  await page.clock.install({ time: new Date("2030-01-01T09:00:00Z") });
  await page.clock.pauseAt(new Date("2030-01-01T09:00:01Z"));
  await open("view=proposal", "full");
  const rename = page.locator('[data-id="junebug"]');
  await rename.getByRole("button", { name: "Rename Juniper to Junebug" }).click();
  assert.equal(await rename.getByRole("button").count(), 0, "a pending rename cannot be declined");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Juniper");
  await page.clock.runFor(800);
  await has(page, '[data-testid="card-renamed"]', "Renamed Juniper to Junebug");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "Junebug");

  // Another card finishing behind an open editor keeps its draft and focus.
  await open("view=proposal", "full");
  await rename.getByRole("button", { name: "Rename Juniper to Junebug" }).click();
  await page.locator('[data-id="otto-instructions"]').getByRole("button", { name: "Review and save" }).click();
  await page.locator("#ed-0").evaluate((el) => el.setSelectionRange(el.value.length, el.value.length));
  await page.keyboard.type("\nAsk before restoring anything.");
  await page.clock.runFor(800);
  await page.getByTestId("own-rename-line").waitFor({ state: "attached" });
  assert.match(await page.locator("#ed-0").inputValue(), /Tell Juniper when one fails\.\nAsk before restoring anything\.$/);
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ed-0");
  await page.keyboard.type(" Twice.");
  assert.match(await page.locator("#ed-0").inputValue(), /Ask before restoring anything\. Twice\.$/);
});

await check("MB-17 agents with access: See by default, no direct changes, the limit, the config", async ({ page, open }) => {
  await open("view=agents");
  assert.equal(await page.getByRole("heading", { level: 1 }).innerText(), "Agents with access");
  await has(page, '[data-testid="grants"]', "Suggest changes · All bots, including later ones");
  await has(page, '[data-testid="grants"]', "Expires in 28 days");
  await open("view=agents&step=add");
  // Direct entry focuses the dialog, so Escape works before any click.
  assert.equal(await page.evaluate(() => document.activeElement?.id), "ag-name");
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("add-agent").count(), 0);
  await open("view=agents&step=add");
  const dialog = page.getByRole("dialog", { name: "Add an agent" });
  assert.deepEqual(await dialog.locator('input[name="scope"]').evaluateAll((r) => r.map((x) => [x.value, x.checked])), [
    ["see", true],
    ["suggest", false],
  ]);
  await has(page, '[data-testid="grant-limit"]', "Anything that can read this agent's secret can do what you allow here.");
  await has(page, '[data-testid="instructions-hint"]', "no instruction changes and no routine prompts");
  assert.equal(await dialog.getByText("Include bots you add later").count(), 1);
  await open("view=agents&step=added");
  await has(page, '[data-testid="added-config"]', "clawtrate-mcp");
  await has(page, '[data-testid="added-config"]', "The secret is shown once.");

  // A real modal: the settings behind are inert, focus stays in, and Escape
  // and Cancel close it without a grant and give focus back to Add an agent.
  await open("view=agents");
  const grants = page.locator('[data-testid="grants"] > li');
  const onAdd = () => page.evaluate(() => document.activeElement?.dataset.act === "add");
  await page.getByRole("button", { name: "Add an agent" }).click();
  assert.equal(await page.locator(".mb-settings").getAttribute("inert"), "");
  await staysIn(page, '[data-testid="add-agent"]');
  await page.keyboard.press("Escape");
  assert.equal(await page.getByTestId("add-agent").count(), 0);
  assert(await onAdd(), "Escape returns focus to Add an agent");
  await page.getByRole("button", { name: "Add an agent" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel" }).click();
  assert.equal(await page.getByTestId("add-agent").count(), 0);
  assert(await onAdd(), "Cancel returns focus to Add an agent");
  assert.equal(await grants.count(), 1);
  assert.equal(await page.getByTestId("added-config").count(), 0);

  // Add keeps everything chosen; later bots come only with All bots.
  await page.getByRole("button", { name: "Add an agent" }).click();
  await page.locator("#ag-name").fill("Aider");
  await page.getByRole("dialog").getByRole("radio", { name: /Suggest changes/ }).check();
  await page.locator("#ag-instructions").check();
  assert(await page.locator("#ag-later").isDisabled(), "later bots wait for All bots");
  await page.getByRole("dialog").getByRole("radio", { name: /All bots/ }).check();
  await page.locator("#ag-later").check();
  await page.locator("#ag-expires").selectOption("7");
  await page.getByRole("dialog").getByRole("button", { name: "Add", exact: true }).click();
  assert.equal(await grants.count(), 2);
  const aider = page.locator('[data-testid="grants"] > li', { hasText: "Aider" });
  await has(page, '[data-testid="grants"] > li:last-child', "Suggest changes, with instructions · All bots, including later ones");
  await has(page, '[data-testid="grants"] > li:last-child', "Expires in 7 days");
  await has(page, '[data-testid="added-config"]', "Paste this into Aider's MCP settings");

  // Remove takes out only that grant.
  await aider.getByRole("button", { name: "Remove Aider's access" }).click();
  assert.equal(await grants.count(), 1);
  await has(page, '[data-testid="grants"]', "Claude Code");
  assert.equal(await page.getByTestId("added-config").count(), 0);
});

await check("MB-18 an ambiguous opening stops and waits for an explicit retry", async ({ page, open }) => {
  await open("view=first&opening=ambiguous");
  await has(page, '[data-testid="card-opening"]', "Clawtrate couldn't confirm the first message reached Clawtrate Main Bot");
  assert.equal(await page.getByTestId("guided").count(), 0);
  assert.equal(await page.locator(".mb-msg.is-user").count(), 1);
  await page.getByRole("button", { name: "Send it again" }).click();
  await page.getByTestId("guided").waitFor();
});

await check("MB-19 a long answer in the composer is sent, clears the composer, and fills the card", async ({ page, open }) => {
  await open("view=first");
  await page.getByTestId("guided").waitFor();
  const role = "Help me plan meals, shopping and the week's errands, and remind me what's coming up. ".repeat(5).trim();
  const long = "Call yourself  Basil   Leaf. " + role;
  await page.locator("#mb-input").fill(long);
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByText("I've put that in the card").waitFor();
  assert.equal(await page.locator("#mb-input").inputValue(), "");
  assert.equal(await page.locator("#g-name").inputValue(), "Basil Leaf");
  assert.equal(await page.locator("#g-role").inputValue(), role);
  await has(page, '[data-testid="proposed-note"]', "Nothing is saved until you press Save.");
  const fits = await page.locator(".mb-msg.is-user .mb-bubble").last().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  assert(fits, "the sent message wraps inside its bubble");
  await page.locator("#g-name").fill("Basil Sprout");
  assert.equal(await page.locator("#g-name").inputValue(), "Basil Sprout");

  const unbroken = "a".repeat(1000);
  await page.locator("#mb-input").fill(unbroken);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const bubble = page.getByText(unbroken, { exact: true });
  assert(await bubble.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "an unbroken word wraps inside its bubble");
});

await browser.close();
console.log(`${passed} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
