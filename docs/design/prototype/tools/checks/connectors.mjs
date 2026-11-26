// Checks prototype/connectors.html against docs/design/connectors.md: every
// state of slice 1 and the Browse, offline, app page, Add and account states of
// slice 2, walked from their controls at 1440, 1100, 800 and 390 px, dark and
// light. No server and no network: the page is opened from disk and every
// http(s) request fails the check.
//
//   node docs/design/prototype/tools/checks/connectors.mjs [--shots]
//
// With --shots it also saves the states listed in SHOTS to docs/screenshots/.

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { chromium, pageUrl } from "./browser.mjs";

const shots = process.argv.includes("--shots");
const WIDTHS = [1440, 1100, 800, 390];
const THEMES = ["dark", "light"];
const SHOTS = [
  ["list", ""],
  ["add", "screen=add"],
  ["program", "screen=add&kind=command", "program"],
  ["server", "screen=server&name=notes"],
  ["signin", "screen=server&name=team-docs&signin=open"],
  ["browse", "view=apps"],
];

const browser = await chromium.launch();
const context = await browser.newContext();
await context.grantPermissions(["clipboard-read", "clipboard-write"]);
const page = await context.newPage();
const errors = [];
const network = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => {
  if (/^https?:/.test(request.url())) network.push(request.url());
});
await page.route(/^https?:/, (route) => route.abort());
page.setDefaultTimeout(30_000);

let passed = 0;
let theme = "dark";
let width = 1440;
const ok = (what) => {
  passed += 1;
  console.log(`ok ${width} ${theme} ${what}`);
};
const open = async (query = "") => {
  await page.goto(`${pageUrl("connectors.html")}?chrome=0&delay=5&theme=${theme}&${query}`);
  await page.locator("#c-root .c-window").waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
};
const section = page.locator(".c-section");
const text = async () => (await section.innerText()).replace(/\s+/g, " ");
const has = async (words, what = words) => {
  await page.waitForFunction((w) => document.querySelector(".c-section")?.innerText.replace(/\s+/g, " ").includes(w), words, { timeout: 5000 }).catch(() => {});
  assert(
    (await text()).includes(words),
    `${what}: expected “${words}” in “${(await text()).slice(0, 400)}”`,
  );
  ok(what);
};
const lacks = async (words, what = `no ${words}`) => {
  assert(!(await text()).includes(words), `${what}: “${words}” should not be shown`);
  ok(what);
};
const click = async (name) => {
  const target = page.getByRole("button", { name, exact: true }).first();
  if (width === 390 && !(await target.isVisible()) && (await page.locator(".c-pane-back").isVisible())) {
    await page.locator(".c-pane-back").click();
  }
  await target.click();
};
const focused = () => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent?.trim() || "");
const fits = async (what) => {
  const over = await page.evaluate(() => {
    const doc = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1;
    const inner = [...document.querySelectorAll(".c-window, .c-section, .c-dialog")].some((el) => el.scrollWidth > el.clientWidth + 1);
    return doc || inner;
  });
  assert(!over, `${what}: something is wider than its box`);
  ok(`${what} fits`);
};
const rowNames = () => page.locator(".c-rows .c-row-name").allInnerTexts();
const back = async () => click("Back to Tool servers");
const toNav = async (name) => {
  if (width === 390 && !(await page.locator(".c-pane-back").isVisible())) await click("Back");
  await click(name);
};

async function states() {
  await open();
  assert.deepEqual(await rowNames(), ["local-search", "notes", "t3code", "team-docs", "wiki"]);
  await has("8 tools");
  await has("Not reached yet");
  await has(width === 390 ? "Needs" : "Needs sign-in");
  await has("Can't reach it");
  await has("Managed in Integrations");
  assert.equal(await page.locator("#c-row-notes").getAttribute("aria-label"), "notes, 8 tools, Pip, Otto and Juniper");
  ok("row name for screen readers");
  await fits("list");

  for (const [state, words] of [
    ["loading", null],
    ["empty", "No tool servers yet. A tool server gives your bots tools from another app or service."],
    ["loadfail", "Couldn't load the gateway's settings."],
  ]) {
    await open(`state=${state}`);
    if (words) await has(words, state);
    else {
      assert.equal(await page.locator(".c-rows[aria-busy=true] .c-grey").count(), 3);
      ok("loading rows");
    }
    await fits(state);
  }
  await open("state=loadfail");
  await click("Try again");
  await has("8 tools", "load again");

  await open("readonlygw=1");
  await has("This gateway's settings are read-only. Tool servers can't be changed here.");
  assert.equal(await page.getByRole("button", { name: "Add a tool server" }).count(), 0);
  assert.equal(await page.locator(".c-access").count(), 0);
  ok("read-only gateway: no add, no request");
  await page.locator("#c-row-notes").click();
  assert.equal(await page.getByRole("button", { name: "Remove" }).count(), 0);
  assert.equal(await page.locator(".c-bots input:not([disabled])").count(), 0);
  ok("read-only gateway: no remove, bots disabled");

  await open("access=read");
  await has("Read-only. Changing tool servers needs admin access.");
  assert.equal(await page.getByRole("button", { name: "Add a tool server" }).count(), 0);
  await click("Request admin access");
  await has("Waiting for the gateway's owner.");
  await click("Check now");
  assert.equal(await page.getByRole("button", { name: "Add a tool server" }).count(), 1);
  ok("admin granted: Add appears");
}

async function addByAddress() {
  await open();
  await click("Add a tool server");
  await has("Add a tool server");
  await click("Add");
  await has("Enter the server's address.");
  assert.equal(await page.locator("#c-url").getAttribute("aria-invalid"), "true");
  assert.equal(await focused(), "c-url");
  ok("empty address: focus on the field");
  await page.locator("#c-url").fill("http://journal.example/mcp");
  await click("Add");
  await has("That isn't a server address. It starts with https://.");
  await page.locator("#c-url").fill("https://notes.example/mcp");
  assert.equal(await page.locator("#c-name").inputValue(), "notes");
  ok("name filled in from the address");
  await click("Add");
  await has("There's already a server named notes. Choose another name.");
  await page.locator("#c-url").fill("https://journal.example/mcp");
  await page.locator("#c-name").fill("journal");
  await page.locator("#c-key").fill("example-key-value");
  assert.equal(await page.locator(".c-bots input:checked").count(), 4);
  ok("from Settings, every bot ticked");
  await page.locator("#c-bot-marlow").uncheck();
  await click("Add");
  await has("Added journal. Pip, Otto and Juniper can use it.");
  await has("The gateway hides the key; Clawtrate can't show it again.");
  assert.equal(await focused(), "Try it with Pip");
  assert(!(page.url().includes("journal") || page.url().includes("example-key")));
  ok("nothing typed is in the address");
  await click("Try it with Pip");
  assert.equal(await page.locator("#c-message").inputValue(), "What can you do with journal?");
  assert.equal(await focused(), "c-message");
  await has("Nothing is sent until you send it.");
  await has("Not reached yet. The gateway connects to journal the next time Pip runs.");
  await click("Send");
  await has("Reached in Pip's task");
  await has("2 tools");
  await back();
  assert((await rowNames()).includes("journal"));
  const journal = page.locator("#c-row-journal");
  assert.equal(await journal.getAttribute("aria-label"), "journal, 2 tools, Pip, Otto and Juniper");
  ok("the list shows the confirmed add and its listing");

  await open("from=pip&screen=add");
  assert.deepEqual(await page.locator(".c-bots input:checked").evaluateAll((els) => els.map((e) => e.dataset.bot)), ["pip"]);
  ok("from a bot's settings, only that bot");
}

async function program() {
  await open("screen=add");
  await page.locator("#c-kind-url").focus();
  await page.keyboard.press("ArrowRight");
  await has("Program");
  assert.equal(await page.locator("#c-kind-command").isChecked(), true);
  ok("kind by arrow key");
  await click("Add");
  await has("Enter the program to run.");
  const raw = "  --stdio  \n\n--index ./my notes\n";
  await page.locator("#c-command").fill(" /opt/example/bin/<em>search</em> ");
  await page.locator("#c-args").fill(raw);
  await page.locator("#c-cwd").fill(" /srv/notes ");
  await page.locator("#c-name").fill("local-two");
  assert.equal(await page.locator("#c-runs .c-runs-program").innerText(), "/opt/example/bin/<em>search</em>");
  assert.equal(await page.locator("#c-runs em").count(), 0);
  ok("typed text shown as text");
  assert.deepEqual(await page.locator("#c-runs .c-arglist li").allInnerTexts(), ["--stdio", "--index ./my notes"]);
  assert.equal(await page.locator("#c-runs .c-runs-cwd").innerText(), "/srv/notes");
  await has("as the user the gateway runs as");
  ok("the form says what will run, from the reviewed values");
  await click("Add");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  ok("no question for a program");
  await has("Added local-two.");
  assert.deepEqual(await page.locator(".c-result .c-arglist li").allInnerTexts(), ["--stdio", "--index ./my notes"]);
  await click("Open local-two");
  assert.deepEqual(await page.locator(".c-facts .c-arglist li").allInnerTexts(), ["--stdio", "--index ./my notes"]);
  await has("Each bot ticked can have the gateway start /opt/example/bin/<em>search</em>.");
  ok("the page shows what was added");

  await open("screen=add&kind=command");
  await page.locator("#c-command").fill("/opt/example/bin/bare");
  assert((await page.locator("#c-runs").innerText()).includes("No arguments"));
  assert.equal(await page.locator("#c-runs .c-runs-cwd").count(), 0);
  ok("no arguments, no folder");
  await page.locator("#c-name").fill("bare");
  await click("Add");
  await has("Added bare.");
  await click("Undo");
  await page.locator("#c-add").waitFor();
  assert(!(await rowNames()).includes("bare"));
  assert.equal(await focused(), "c-add");
  ok("Undo takes the add back");
}

async function outcomes() {
  const add = async (query) => {
    await open(`screen=add&${query}`);
    await page.locator("#c-url").fill("https://journal.example/mcp");
    await click("Add");
  };
  await add("write=refused");
  await has("Couldn't add journal: the gateway is busy with another change. Try again in a moment.");
  await click("Back to the form");
  assert.equal(await page.locator("#c-url").inputValue(), "https://journal.example/mcp");
  await back();
  assert(!(await rowNames()).includes("journal"));
  ok("refused: nothing added, form kept");

  await add("write=stale");
  await has("The gateway's settings changed while you were here.");

  await add("write=noanswer&read=absent");
  await has("The gateway's settings have no server named journal. Nothing was added.");

  await add("write=noanswer&read=fails");
  await has("Couldn't confirm the change. The gateway's settings couldn't be read.");
  await back();
  assert(!(await rowNames()).includes("journal"));
  ok("an unconfirmed add leaves the list as it was");
  await page.getByRole("button", { name: "Add a tool server" }).click();
  await page.locator("#c-url").fill("https://journal.example/mcp");
  await page.evaluate(() => {
    window.connectorsPrototype.ui.nextWrite = "noanswer";
    window.connectorsPrototype.ui.nextRead = "fails";
  });
  await click("Add");
  await has("couldn't be read");
  await page.evaluate(() => (window.connectorsPrototype.ui.nextRead = "fails"));
  await click("Check again");
  await has("couldn't be read", "check again can fail again");
  await click("Check again");
  await has("The gateway has journal with these settings.");

  await add("write=differs");
  await has("Couldn't confirm the change. The gateway has a different entry for journal.");
  await has("https://journal.example/v2/mcp");
  await click("Open journal");
  await has("https://journal.example/v2/mcp", "the page shows the entry as read");

  await open("screen=add&kind=command&write=differs");
  await page.locator("#c-command").fill("/opt/example/bin/search-server");
  await page.locator("#c-args").fill("--stdio");
  await page.locator("#c-name").fill("local-two");
  await click("Add");
  await has("The gateway has a different entry for local-two.");
  assert.deepEqual(await page.locator(".c-result .c-arglist li").allInnerTexts(), ["--stdio", "--read-only"]);
  ok("a command read back differently shows the command as read");
}

async function bots() {
  await open("screen=server&name=notes");
  await has("Juniper's tool rules don't offer notes's tools.");
  await page.locator("#c-bot-otto").uncheck();
  await page.waitForFunction(() => !document.querySelector("#c-bot-otto")?.disabled);
  assert.equal(await page.locator("#c-bot-otto").isChecked(), false);
  assert.equal(await focused(), "c-bot-otto");
  await back();
  assert.equal(await page.locator("#c-row-notes").getAttribute("aria-label"), "notes, 8 tools, Pip and Juniper");
  ok("unticking writes and the list agrees");

  await open("screen=server&name=notes&botwrite=refused");
  await page.locator("#c-bot-pip").click();
  await has("Couldn't change Pip: the gateway is busy with another change.");
  assert.equal(await page.locator("#c-bot-pip").isChecked(), true);
  ok("refused: the checkbox is put back");
}

async function remove() {
  await open("screen=server&name=wiki");
  await has("Remove takes");
  await click("Remove");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  await has("Removed wiki.");
  assert(!(await rowNames()).includes("wiki"));
  assert.equal(await focused(), "c-undo");
  ok("nothing to lose: removed at once, Undo focused");
  await click("Undo");
  await page.locator("#c-row-wiki").waitFor();
  ok("Undo puts it back");

  await open("screen=server&name=notes");
  await click("Remove");
  const q = page.getByRole("alertdialog", { name: "Remove notes?" });
  await q.waitFor();
  assert((await q.innerText()).includes("Its key goes with it, and Clawtrate can't put it back"));
  await page.keyboard.press("Escape");
  assert.equal(await focused(), "c-remove");
  await click("Remove");
  await page.getByRole("button", { name: "Remove notes" }).click();
  await page.locator("#c-row-local-search").waitFor();
  assert(!(await rowNames()).includes("notes"));
  assert.equal(await page.getByRole("button", { name: "Undo" }).count(), 0);
  ok("a key to lose: one question, then removed");
}

async function signin() {
  await open("screen=server&name=team-docs");
  await has("team-docs needs you to sign in.");
  await click("Sign in");
  await has("The gateway's page is open in your browser.");
  await has("http://127.0.0.1:18789/settings/mcp");
  assert.equal(await focused(), "c-code");
  await page.locator("#c-code").pressSequentially("abcdefgh");
  const prompt = page.getByRole("alertdialog", { name: "Let this browser control studio?" });
  await prompt.waitFor();
  assert((await prompt.innerText()).includes("ABCD-EFGH"));
  assert((await prompt.innerText()).includes("(reported)"));
  await page.getByRole("button", { name: "Approve" }).click();
  await has("Browser approved. It connects by itself.");
  assert.equal(await focused(), "c-back-here");
  await click("I'm back");
  await has("The gateway's page signs in for every bot that can use team-docs.");
  await click("Try it with Pip");
  await click("Send");
  await has("Reached in Pip's task");
  ok("sign in, then the tools");

  await open("screen=server&name=team-docs&code=expired");
  await click("Sign in");
  await page.locator("#c-code").pressSequentially("ABCDEFGH");
  await has("This code has expired. Choose Pair this browser again on the gateway's page.");
  assert.equal(await page.getByRole("alertdialog").count(), 0);
  ok("an expired code is not approved");

  await open("screen=server&name=team-docs&pageaddr=none");
  await click("Sign in");
  await has("Signing in needs the gateway's page in a browser.");

  await open("screen=server&name=team-docs");
  await click("Sign out");
  const out = page.getByRole("alertdialog", { name: "Sign out of team-docs?" });
  await out.waitFor();
  assert.equal(await focused(), "Cancel");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), "Cancel");
  ok("focus stays in the sign-out question");
  await page.keyboard.press("Escape");
  assert.equal(await focused(), "c-signout");
  await click("Sign out");
  await page.locator(".c-dialog").getByRole("button", { name: "Sign out" }).click();
  await has("Signed out of team-docs. Bots that use it need a new sign-in.");

  await open("gw=1006&screen=server&name=team-docs");
  await has("team-docs refused the gateway. It needs a key or an account sign-in.");
  assert.equal(await page.getByRole("button", { name: "Sign out" }).count(), 0);
  await has("Its saved sign-in, in the gateway's state, unencrypted.");
  await click("Sign in");
  await click("Copy the gateway's secret");
  await has("Copied. Paste it on the gateway's page.");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "example-gateway-secret");
  ok("2026.10.6: the secret copied, once");
  await open("gw=1006&screen=server&name=team-docs");
  await page.evaluate(() => (navigator.clipboard.writeText = () => Promise.reject(new Error("denied"))));
  await click("Sign in");
  await click("Copy the gateway's secret");
  await has("Couldn't copy the gateway's secret.");
  await open("gw=1006&screen=server&name=team-docs&hostsecret=0");
  await click("Sign in");
  await has("paste it there, from where you keep it.");
}

async function apps() {
  await open("view=apps");
  await has("Featured");
  await has("Quillnote");
  const chip = page.locator('.c-chip[data-id="all"]');
  await chip.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await page.locator('.c-chip[aria-checked="true"]').getAttribute("data-id"), "productivity");
  await lacks("Ledgerkin", "category filters");
  await page.keyboard.press("ArrowLeft");
  await page.locator("#c-search").fill("ledg");
  assert.deepEqual(await page.locator(".c-rows .c-row-name").allInnerTexts(), ["Ledgerkin"]);
  ok("search shows only matches");
  await page.locator("#c-search").fill("zzz");
  await has("No apps match.");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#c-search").inputValue(), "");
  ok("Escape clears search");

  await page.locator('[data-app="quillnote"] .c-row').first().click();
  await click("Add");
  const q = page.getByRole("alertdialog", { name: "Add Quillnote to studio?" });
  await q.waitFor();
  assert((await q.innerText()).includes("runs it with the gateway's access"));
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await has("Added Quillnote. The gateway lists it as installed and turned on.");
  await toNav("On this gateway");
  await has("Quillnote", "On this gateway lists the confirmed install");
  await page.locator('[data-app="quillnote"] .c-row').first().click();
  await click("Turn off");
  await has("Turned off. Its settings and any saved sign-ins stay.");
  await click("Turn on");
  await has("Turned on.");
  await click("Remove");
  await page.getByRole("button", { name: "Remove Quillnote" }).click();
  await has("On this gateway");
  await lacks("Quillnote", "removed app leaves On this gateway");

  await open("view=apps&screen=app&app=calendrop");
  await has("Signed in. The gateway reports saved sign-in tokens.");
  await has("Needs sign-in.");
  await click("Sign in");
  await click("I'm back");
  await has("calendrop-cal: signed in.");

  await open("view=apps&catalog=offline");
  await has("The catalog can't be reached from the gateway.");
  assert.equal(await page.locator(".c-chip").count(), 0);
  await lacks("Featured");
  await lacks("Quillnote", "offline: nothing to add");
  await page.locator("#c-search").fill("zzz");
  await has("No installed apps match on this gateway.");
  await has("Searching skills needs the catalog.");
  await page.keyboard.press("Escape");
  await click("Try again");
  await has("Featured", "the catalog answers again");

  await open("view=apps&catalog=refused");
  await has("Couldn't load the catalog.");
  await open("view=apps&readonlygw=1");
  await has("This gateway's settings are read-only. Plugins and tool servers can't be changed here.");
}

try {
  for (width of WIDTHS) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (theme of THEMES) {
      await states();
      await addByAddress();
      await program();
      await outcomes();
      await bots();
      await remove();
      await signin();
      await apps();
      for (const [, query, extra] of SHOTS) {
        await open(query);
        if (extra === "program") {
          await page.locator("#c-command").fill("/opt/example/bin/search-server");
          await page.locator("#c-args").fill("--stdio\n--index ./notes");
          await page.locator("#c-cwd").fill("/srv/notes");
          await page.locator("#c-name").fill("local-search-2");
        }
        await fits(query || "list");
      }
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(network, []);
  if (shots) {
    const out = fileURLToPath(new URL("../../../../screenshots/", import.meta.url));
    for (width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (theme of THEMES) {
        for (const [name, query, extra] of SHOTS) {
          await open(query);
          if (extra === "program") {
            await page.locator("#c-command").fill("/opt/example/bin/search-server");
            await page.locator("#c-args").fill("--stdio\n--index ./notes");
            await page.locator("#c-cwd").fill("/srv/notes");
            await page.locator("#c-name").fill("local-search-2");
            await page.locator("#c-runs").scrollIntoViewIfNeeded();
          }
          await page.screenshot({ path: `${out}connectors-${name}-${width === 390 ? "phone" : width}-${theme}.png` });
        }
      }
    }
    console.log(`saved ${SHOTS.length * 4} screenshots to docs/screenshots/`);
  }
  console.log(`all ${passed} checks passed`);
} catch (error) {
  console.log(`FAIL ${width} ${theme}: ${error.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
