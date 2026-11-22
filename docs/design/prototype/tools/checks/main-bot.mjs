// Checks prototype/main-bot.html against docs/design/main-bot-onboarding.md
// (the autonomy step and the first run):
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

await check("MB-05 Save without a name writes nothing", async ({ page, open }) => {
  await open("view=first");
  await page.getByTestId("guided").getByRole("button", { name: "Save" }).click();
  await has(page, '[data-testid="guided-problem"]', "Give your Main Bot a name first.");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "main");
});

await check("MB-06 the rail and header wait for the gateway's answer", async ({ page, open, width }) => {
  await open("view=first&at=saving");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "main");
  if (width !== "phone") assert.equal(await railName(page, "main", width), "main");
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
  if (width !== "phone") assert.equal(await railName(page, "main", width), "Fennel Bulb");
  assert.equal(await page.getByTestId("title-pill").getAttribute("aria-label"), "Fennel Bulb, Main Bot");
  await has(page, ".mb-transcript", "Call yourself Fennel Bulb. Help me plan the garden.");
});

await check("MB-08 unconfirmed and stale saves leave the name and say why", async ({ page, open }) => {
  await open("view=first&card=unconfirmed");
  await page.getByTestId("guided-problem").waitFor();
  await has(page, '[data-testid="guided-problem"]', "Clawtrate couldn't confirm whether this changed.");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "main");
  await open("view=first&card=stale");
  await page.getByTestId("guided-problem").waitFor();
  await has(page, '[data-testid="guided-problem"]', "so nothing was saved");
  assert.equal((await page.getByTestId("title-name").innerText()).trim(), "main");
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

await check("MB-18 an ambiguous opening stops and waits for an explicit retry", async ({ page, open }) => {
  await open("view=first&opening=ambiguous");
  await has(page, '[data-testid="card-opening"]', "Clawtrate couldn't confirm the first message reached main");
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
