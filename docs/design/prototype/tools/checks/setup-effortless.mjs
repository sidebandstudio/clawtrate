// Checks for setup-effortless.html (docs/design/setup-effortless.md): every link on
// every screen goes somewhere that exists, "What this means" opens its page and comes
// back, and the approve prompt is modal: the app behind it is inert, Tab and Shift+Tab
// stay inside it, Enter never decides, and Escape closes it and returns focus.
// Run from the repository root:  node docs/design/prototype/tools/checks/setup-effortless.mjs
import assert from "node:assert/strict";
import { chromium, pageUrl } from "./browser.mjs";

const SCREENS = ["settings", "found", "unverified", "means", "connecting", "another", "waiting", "approve"];
const DEVICE = "K7QF-2MXA-9TRB-W4HD";

const browser = await chromium.launch();
const page = await browser.newPage({ colorScheme: "dark" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route(/^https?:/, (route) => route.abort());
const open = (query) => page.goto(`${pageUrl("setup-effortless.html")}?chrome=0&${query}`);
const screenOf = () => new URL(page.url()).searchParams.get("screen");
const inside = () => page.evaluate(() => !!document.activeElement?.closest(".se-prompt"));

try {
  // Every same-page anchor names an id on its page.
  for (const screen of SCREENS)
    for (const extra of screen === "another" ? ["", "&tab=ssh", "&tab=code", "&warn=ws", "&warn=cert"] : [""]) {
      await open(`screen=${screen}${extra}`);
      const missing = await page.evaluate(() =>
        [...document.querySelectorAll('a[href^="#"]')]
          .map((a) => a.getAttribute("href").slice(1))
          .filter((id) => !id || !document.getElementById(id)),
      );
      assert.deepEqual(missing, [], `screen=${screen}${extra}: anchors with no target`);
    }
  console.log("ok every in-page link has a target");

  // "What this means" opens its page and Back returns to the card it came from.
  for (const [from, query] of [
    ["found", "screen=found"],
    ["another", "screen=another&tab=address"],
  ]) {
    await open(query);
    await page.getByRole("link", { name: "What this means", exact: true }).click();
    assert.equal(screenOf(), "means");
    assert.equal(await page.locator("#what-this-means").count(), 1);
    await page.getByText("If this device is lost, remove it from another admin connection.").waitFor();
    await page.getByRole("link", { name: "Back" }).click();
    assert.equal(screenOf(), from);
  }
  console.log("ok What this means opens its page and goes back");

  // The approve prompt is modal.
  for (const typed of ["", DEVICE]) {
    await open(`screen=approve${typed ? `&typed=${typed}` : ""}`);
    assert.equal(await page.evaluate(() => document.activeElement?.id), "se-prompt-title");
    assert.equal(await page.evaluate(() => document.getElementById("setup-root").inert), true);
    assert.equal(await page.evaluate(() => document.getElementById("setup-over").inert), false);
    const stops = new Set();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      assert.ok(await inside(), `Tab ${i + 1} left the prompt (typed=${typed || "none"})`);
      stops.add(await page.evaluate(() => document.activeElement.id || document.activeElement.textContent.trim()));
    }
    assert.equal(stops.has("se-approve"), !!typed, "Approve is a stop only on a match");
    await page.locator("#se-prompt-title").focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+Tab");
      assert.ok(await inside(), `Shift+Tab ${i + 1} left the prompt (typed=${typed || "none"})`);
    }
    // Enter in the code never sends a decision; on a match it moves focus to Approve.
    await page.locator(".se-code-input").focus();
    await page.keyboard.press("Enter");
    assert.equal(screenOf(), "approve");
    assert.equal(await page.evaluate(() => document.activeElement.id), typed ? "se-approve" : "");
    // Escape closes the prompt in place and gives focus back to the app.
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".se-prompt").count(), 0);
    assert.equal(await page.evaluate(() => document.getElementById("setup-root").inert), false);
    assert.equal(screenOf(), "found");
    assert.ok(await page.evaluate(() => !!document.activeElement?.closest("#setup-card")), "focus returns to the app");
  }
  console.log("ok the approve prompt is modal, Enter never decides, Escape closes it");

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
