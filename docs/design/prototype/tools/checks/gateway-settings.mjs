// Checks prototype/gateway-settings.html against docs/design/gateway-settings.md: one "OpenClaw"
// row in Settings' list (section 3), its parts as tabs inside it with the tab pattern's keys, the
// line a change leaves with Put back (section 6), a bot's change as a card (section 8), the phone
// width with no sideways scroll, and no page error.
import assert from "node:assert/strict";
import { chromium, pageUrl } from "./browser.mjs";

const browser = await chromium.launch();
let passed = 0;
let failed = 0;
const check = async (name, run) => {
  try {
    await run();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${String(error.message).split("\n")[0]}`);
  }
};

const open = async (query, viewport = { width: 1100, height: 760 }) => {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(`${pageUrl("gateway-settings.html")}?chrome=0&motion=reduce&${query}`);
  return { page, errors };
};
const navNames = (page) =>
  page.locator(".gs-nav .gs-nav-item").evaluateAll((items) => items.map((i) => i.textContent));

await check("Settings' list has one OpenClaw row and none of its parts", async () => {
  const { page, errors } = await open("screen=models");
  const names = await navNames(page);
  assert.deepEqual(names, [
    "Gateway",
    "Accounts",
    "OpenClaw",
    "Conversation",
    "Usage",
    "Machines",
    "Updates",
    "Advanced",
  ]);
  assert.equal(
    await page.locator('.gs-nav-item[aria-current="page"]').textContent(),
    "OpenClaw",
  );
  assert.deepEqual(errors, []);
  await page.close();
});

await check("OpenClaw opens on Models under its heading, with the parts as tabs", async () => {
  const { page } = await open("screen=chat");
  await page.getByRole("button", { name: "OpenClaw", exact: true }).click();
  assert.equal(await page.locator("#gs-title").textContent(), "OpenClaw");
  const tabs = page.getByRole("tab");
  assert.deepEqual(await tabs.allTextContents(), ["Models", "Chat apps", "Plugins", "All settings"]);
  assert.equal(await page.getByRole("tablist").getAttribute("aria-label"), "OpenClaw settings");
  assert.equal(await page.getByRole("tab", { name: "Models" }).getAttribute("aria-selected"), "true");
  assert.equal(
    await page.getByRole("tabpanel").getAttribute("aria-labelledby"),
    "gs-tab-models",
  );
  await page.close();
});

await check("arrows, Home and End move between the parts and keep focus on the tab", async () => {
  const { page } = await open("screen=models");
  await page.getByRole("tab", { name: "Models" }).focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "gs-tab-chat");
  assert.match(await page.getByRole("tabpanel").textContent(), /Connect a chat app/);
  await page.keyboard.press("End");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "gs-tab-all");
  await page.keyboard.press("Home");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "gs-tab-models");
  await page.keyboard.press("ArrowLeft");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "gs-tab-all");
  await page.close();
});

await check("connecting a chat app stays under the OpenClaw row", async () => {
  const { page } = await open("screen=telegram");
  assert.equal(
    await page.locator('.gs-nav-item[aria-current="page"]').textContent(),
    "OpenClaw",
  );
  assert.equal(await page.locator("#gs-title").textContent(), "Connect Telegram");
  await page.close();
});

await check("a change leaves one line with Put back and the earlier value", async () => {
  const { page } = await open("screen=models");
  await page.locator("#gs-default").selectOption("acme/swift-2");
  assert.match(await page.locator(".gs-done").textContent(), /Default model is now Swift 2, on Work\./);
  await page.getByRole("button", { name: "Put back Swift 1" }).click();
  assert.equal(await page.locator(".gs-done").count(), 0);
  await page.close();
});

await check("a bot's changes are cards: one pressed, one waiting with Change and restart", async () => {
  const { page } = await open("screen=bot");
  const cards = await page.locator(".gs-ask").allTextContents();
  assert.equal(cards.length, 2);
  assert.match(cards[0], /Changed/);
  assert.match(cards[1], /Change and restart/);
  await page.close();
});

await check("at phone width, Back shows the list, OpenClaw opens its tabs, and nothing scrolls sideways", async () => {
  const { page, errors } = await open("screen=models&width=phone", { width: 390, height: 844 });
  const sideways = () =>
    page.evaluate(
      () =>
        document.documentElement.scrollWidth > innerWidth ||
        [...document.querySelectorAll(".gs-body, .gs-parts")].some(
          (e) => e.scrollWidth > e.clientWidth + 1,
        ),
    );
  assert.equal(await sideways(), false);
  await page.locator(".gs-back").click();
  await page.getByRole("button", { name: "OpenClaw", exact: true }).click();
  assert.equal(await page.getByRole("tab").count(), 4);
  assert.equal(await sideways(), false);
  assert.deepEqual(errors, []);
  await page.close();
});

await browser.close();
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
