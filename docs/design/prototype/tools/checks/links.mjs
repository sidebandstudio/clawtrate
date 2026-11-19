import assert from "node:assert/strict";
import { chromium, pageUrl } from "./browser.mjs";

const example = "Review the opening.";
const existing = "Keep the second paragraph as it is.";
const added = "Link text added to your draft. Nothing was sent.";
const gateway = "a".repeat(64);
const prefix = "clawtrate://chat?";
const fields = `bot=marlow&gateway=${gateway}`;
const link = `${prefix}${fields}&text=`;
const failures = {
  malformed: "This Clawtrate link is invalid. Ask for a new link.",
  disconnected:
    "Clawtrate isn’t connected to a gateway. Connect to the right gateway, then open the link again.",
  different:
    "This link is for a different gateway. Connect to that gateway, then open the link again.",
  unavailable:
    "Clawtrate couldn’t verify the gateway or load its bots and chats. Open the link again when they’re available.",
  unknown: "This bot isn’t on the connected gateway. Check the link or ask for a new one.",
  "no-chat": "This bot has no chat to open.",
  readonly: "This device can read this chat. It can’t edit the draft.",
};

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
const network = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (/^https?:/.test(request.url())) network.push(request.url());
});
await page.route(/^https?:/, (route) => route.abort());
const input = page.locator(".composer-input");
const dialog = page.getByRole("dialog");
const button = (name) => page.getByRole("button", { name, exact: true });
const focused = (locator) => locator.evaluate((element) => element === document.activeElement);
const status = page.locator("#links-status");
const open = async (scene, url) => {
  const params = new URLSearchParams({ chrome: "0", theme, scene });
  if (url !== undefined) params.set("link", url);
  await page.goto(pageUrl("links.html") + "?" + params);
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
};
const nothingSent = async () => {
  assert.equal(await page.locator("#transcript .turn").count(), 2);
  assert.deepEqual(network, []);
};
const opened = async (text) => {
  assert.equal(await dialog.count(), 0);
  assert.equal(await input.getAttribute("aria-label"), "Message Marlow");
  assert.equal(await input.inputValue(), text);
  assert(await focused(input));
  assert.equal(await input.evaluate((element) => element.selectionStart), text.length);
  assert.equal(await input.evaluate((element) => element.selectionEnd), text.length);
  assert.equal(await status.getAttribute("role"), "status");
  assert.equal(await status.textContent(), added);
  await nothingSent();
};
const cannot = async (reason) => {
  assert(await page.getByRole("dialog", { name: "Can’t open link", exact: true }).isVisible());
  assert.equal(await dialog.getAttribute("aria-describedby"), "links-detail");
  assert.equal(await page.locator("#links-detail").textContent(), reason);
  assert.equal(await dialog.getByRole("button").count(), 1);
  assert(await focused(button("Close")));
  assert.deepEqual(
    await page.evaluate(() => [window.app.model.selectedBot, window.app.model.drafts]),
    ["juniper", {}],
  );
  assert.equal(await status.textContent(), "");
};

let theme = "light";
try {
  for (const width of [1440, 1100, 800, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (theme of ["light", "dark"]) {
      for (const scene of ["opened", "loading", "draft", ...Object.keys(failures)]) {
        await open(scene);
        const fits = await page.evaluate(() =>
          [
            document.documentElement,
            document.querySelector(".proto-stage"),
            document.querySelector(".conversation"),
            ...document.querySelectorAll("dialog[open], dialog[open] .b-actions"),
          ].every((element) => element.scrollWidth <= element.clientWidth),
        );
        assert(fits, `${scene} at ${width} in ${theme} scrolls sideways`);
        assert.equal(await page.locator(".back-button").isVisible(), width === 390);
        if (scene === "opened") {
          await opened(example);
          await input.fill("An edit");
          assert.equal(await status.textContent(), "");
          await input.press("Enter");
          await button("Send").click();
          assert.equal(await input.inputValue(), "An edit");
          await nothingSent();
        } else if (scene === "loading") {
          assert.equal(await dialog.count(), 0);
          assert.equal(
            await page.locator('[aria-label="Loading conversation"]').getAttribute("aria-busy"),
            "true",
          );
          assert.equal(await input.inputValue(), "");
          assert.equal(await status.textContent(), "");
          assert.equal(await page.locator("#transcript .turn").count(), 0);
        } else if (scene === "draft") {
          assert(
            await page
              .getByRole("dialog", {
                name: "Replace your draft?",
                exact: true,
              })
              .isVisible(),
          );
          assert.equal(await dialog.getAttribute("aria-describedby"), "links-detail");
          assert.equal(
            await page.locator("#links-detail").textContent(),
            "You already have a draft in this chat with Marlow. Replacing it discards that draft.",
          );
          assert.equal(await input.inputValue(), existing);
          assert.equal(await status.textContent(), "");
          assert(await focused(button("Keep draft")));
          await page.keyboard.press("Shift+Tab");
          assert(await focused(button("Replace draft")));
          await page.keyboard.press("Tab");
          assert(await focused(button("Keep draft")));
          await page.keyboard.press("Enter");
          await page.waitForFunction(() => document.activeElement.matches(".composer-input"));
          assert.equal(await input.inputValue(), existing);
          await nothingSent();
          await open(scene);
          await page.keyboard.press("Escape");
          await page.waitForFunction(() => document.activeElement.matches(".composer-input"));
          assert.equal(await input.inputValue(), existing);
          await open(scene);
          await button("Replace draft").click();
          await opened(example);
        } else {
          await cannot(failures[scene]);
          await page.keyboard.press("Tab");
          assert(await focused(button("Close")));
          await page.keyboard.press(width === 390 ? "Escape" : "Enter");
          await page.waitForFunction(() => document.activeElement.id === "title-pill");
          assert.equal(await dialog.count(), 0);
          assert.deepEqual(await page.evaluate(() => window.app.model.drafts), {});
        }
      }
      console.log(`ok F-248 every link state at ${width}px in ${theme}`);
    }
  }

  const malformed = {
    scheme: `https://chat?${fields}&text=x`,
    casing: link.replace("clawtrate", "CLAWTRATE") + "x",
    route: link.replace("://chat?", "://settings?") + "x",
    userinfo: link.replace("://chat?", "://sample@chat?") + "x",
    port: link.replace("://chat?", "://chat:123?") + "x",
    path: link.replace("://chat?", "://chat/?") + "x",
    fragment: link + "x#sample",
    duplicate: link + "x&text=y",
    separator: link + "x&",
    "missing equals": link + "x&bot",
    "extra equals": link + "x=y",
    "missing bot": `${prefix}gateway=${gateway}&text=x`,
    "missing gateway": `${prefix}bot=marlow&text=x`,
    "missing text": prefix + fields,
    "empty bot": link.replace("marlow", "") + "x",
    "long bot": link.replace("marlow", "a".repeat(65)) + "x",
    "unsafe bot": link.replace("marlow", "mar%2Flow") + "x",
    "uppercase bot": link.replace("marlow", "Marlow") + "x",
    "invalid identity": link.replace(gateway, "A".repeat(64)) + "x",
    "short identity": link.replace(gateway, "a") + "x",
    "encoded field name": link.replace("bot=", "b%6Ft=") + "x",
    address: link + "x&address=example",
    token: link + "x&token=sample",
    task: link + "x&task=sample",
    send: link + "x&send=1",
    empty: link,
    blank: link + "%20%0A%09",
    plus: link + "a+b",
    "literal whitespace": link + "a b",
    "literal Unicode": link + "é",
    escape: link + "%G0",
    "short escape": link + "%0",
    utf8: link + "%FF",
    surrogate: link + "%ED%A0%80",
    control: link + "%00x",
    "delete control": link + "x%7F",
    bidi: link + "x%E2%80%AE",
    "line separator": link + "x%E2%80%A8",
    "too much text": link + "a".repeat(2001),
    "too long a URL": link + "%20".repeat(2800) + "a",
  };
  theme = "light";
  for (const [name, url] of Object.entries(malformed)) {
    await open("opened", url);
    await cannot(failures.malformed);
    console.log(`ok F-248 refused ${name}`);
  }

  for (const [url, text] of [
    [
      `${prefix}text=%20Hi%09there%0D%0A%F0%9F%8C%B1%0DBye%20&gateway=${gateway}&bot=%6Darlow`,
      "Hi there\n🌱\nBye",
    ],
    [link + "a%2Bb%26c%3Dd%23e%2520", "a+b&c=d#e%20"],
    [
      link + encodeURIComponent("<img src=x onerror=alert`1`> **hi**").replaceAll("*", "%2A"),
      "<img src=x onerror=alert`1`> **hi**",
    ],
    [link + "a".repeat(2000), "a".repeat(2000)],
    [
      link +
        "%20".repeat(Math.floor((8192 - link.length - 1) / 3)) +
        "a".repeat(((8192 - link.length - 1) % 3) + 1),
      "a".repeat(((8192 - link.length - 1) % 3) + 1),
    ],
  ]) {
    await open("opened", url);
    await opened(text);
    assert.equal(await page.locator("#composer img").count(), 0);
  }
  await page.goto(pageUrl("gallery.html"));
  await page.getByRole("link", { name: "Links into a bot’s chat", exact: true }).click();
  assert.equal(new URL(page.url()).pathname.split("/").at(-1), "links.html");
  assert.deepEqual(errors, []);
  console.log("ok F-248 accepted text stays plain, editable and unsent");
} finally {
  await browser.close();
}
