// Checks for settings.html: every walk of docs/design/settings.md section 18
// clicked through to its outcome, each destination's words asserted; every
// state's words and structure; what the page must not draw; the keyboard,
// phone and width rules.
// Run from the repository root:  node docs/design/prototype/tools/checks/settings.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("settings.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${ok ? "" : extra}`);
};
const open = async (query = "", { width = 1440, height = 900, theme = "light" } = {}) => {
  const p = await b.newPage({ viewport: { width, height } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}&theme=${theme}${width === 390 ? "&width=phone" : ""}&${query}`);
  await p.waitForTimeout(150);
  p.errors = errors;
  return p;
};
const text = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].map((e) => e.textContent).join(" ").replace(/\s+/g, " "), sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const has = async (p, sel, words) => {
  const t = await text(p, sel);
  return [missing(t, words) === "", missing(t, words)];
};
const click = async (p, selector, wait = 120) => {
  await p.locator(selector).first().click();
  await p.waitForTimeout(wait);
};
const role = (p, r, name) => p.getByRole(r, { name, exact: true }).first();
const press = async (p, r, name, wait = 120) => {
  await role(p, r, name).click();
  await p.waitForTimeout(wait);
};
const announced = (p) => p.evaluate(() => document.querySelector("#b-announce").textContent);
const settings = "#settings-dialog";
const confirm = "#confirm-dialog";
const rail = (p) => text(p, "#bot-list");
const footer = (p) => text(p, ".gateway-pill");
const stateWords = async (name, query, sel, words, opts) => {
  const p = await open(query, opts);
  const [ok, miss] = await has(p, sel, words);
  check(name, ok && p.errors.length === 0, `missing: ${miss} ${p.errors.join(" | ")}`);
  await p.close();
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: Settings as a whole --------------------------------------------------------------------------

{
  const p = await open("open=settings&section=gateways");
  const nav = await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-nav-item")].map((e) => e.textContent.trim()));
  const want = ["Gateway", "Your gateways", "Accounts", "Integrations", "Permissions", "Memory", "Usage", "Machines", "Appearance", "System", "Updates"];
  check("sections: the order of section 3", JSON.stringify(nav) === JSON.stringify(want), JSON.stringify(nav));
  const all = await text(p, settings);
  check("sections: no Language, security keys, routing or Notifications drawn", !/Language|security key|Route traffic|Notifications/i.test(all));
  check("sections: Your gateways is current", (await p.evaluate(() => document.querySelector('#settings-dialog .b-nav-item[aria-current="page"]')?.textContent.trim())) === "Your gateways");
  await p.close();
}
{
  const p = await open("open=settings&section=gateways", { width: 390, height: 844 });
  const nav = await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-nav-item")].map((e) => e.textContent.trim()));
  check("phone: no System and no Updates", !nav.includes("System") && !nav.includes("Updates") && nav.includes("Appearance"), JSON.stringify(nav));
  const sideways = await p.evaluate(() => document.querySelector("#settings-dialog .b-section-body").scrollWidth > document.querySelector("#settings-dialog .b-section-body").clientWidth + 1);
  check("phone: Your gateways has no sideways scroll", !sideways);
  await p.close();
}
{
  const p = await open("open=settings&section=system", { width: 390, height: 844 });
  check("phone: an address asking for System gets Appearance", (await text(p, "#b-section-title")) === "Appearance");
  await p.close();
}
await stateWords("Gateway pane: Other gateways and Remove this gateway…, not Use another gateway", "open=settings&section=gateway", settings, ["Address", "gateway.local", "Granted scopes", "Other gateways", "Remove this gateway…"]);
{
  const p = await open("open=settings&section=gateway");
  check("Gateway pane: no Use another gateway", !(await text(p, settings)).includes("Use another gateway"));
  await press(p, "button", "Other gateways");
  check("Gateway pane: Other gateways opens Your gateways", (await text(p, "#b-section-title")) === "Your gateways");
  await p.close();
}

// Part 2: Your gateways and a gateway's page --------------------------------------------------------------

await stateWords("Your gateways: its words and rows", "open=settings&section=gateways", settings, [
  "Clawtrate uses one gateway at a time. Each keeps its own pairing on this device, and nothing from one is sent to another.",
  "Home gateway",
  "gateway.local · In use",
  "Studio gateway",
  "devbox, over SSH · Last used Nov 18, 4:02 PM",
  "Switch",
  "Add gateway…",
]);
await stateWords("Your gateways, one gateway: the hint", "open=settings&section=gateways&gateways=one", settings, ["Add another gateway to switch between them here or from the gateway menu."]);
await stateWords("A gateway's page: what was recorded, Switch and Remove", "open=settings&section=gateways&gw=studio", settings, [
  "Studio gateway",
  "Route",
  "devbox, over SSH",
  "Last used",
  "Nov 18, 4:02 PM",
  "This device there",
  "Paired, device 9c2e41 · Read-only",
  "Identity",
  "7be0c914a2f1",
  "Nothing is read from a gateway that isn't in use.",
  "Switch to Studio gateway",
  "Remove…",
]);
{
  const p = await open("open=settings&section=gateways&gw=studio");
  await press(p, "button", "Back to your gateways");
  check("A gateway's page: Back returns to the list", (await text(p, "#b-section-title")) === "Your gateways");
  await p.close();
}

// Part 3: switching (section 6) ----------------------------------------------------------------------------

{
  const p = await open();
  await click(p, ".gateway-pill");
  const items = await p.evaluate(() => [...document.querySelectorAll('#gateway-menu [data-s="switch"]')].map((e) => [e.textContent.trim(), e.getAttribute("role"), e.getAttribute("aria-checked")]));
  check("menu: one menuitemradio for each gateway, the one in use checked", JSON.stringify(items) === JSON.stringify([["Home gateway", "menuitemradio", "true"], ["Studio gateway", "menuitemradio", "false"]]), JSON.stringify(items));
  check("menu: Add gateway…", (await text(p, "#gateway-menu")).includes("Add gateway…"));
  await click(p, '#gateway-menu [data-gw="studio"]', 200);
  const between = await rail(p);
  const strip = await text(p, "#status-strip");
  check("walk: switch, nothing waiting: Home's bots leave at once", between.includes("Loading this gateway's bots.") && !between.includes("Otto"), between);
  check("walk: switch: the strip says Connecting to Studio gateway", strip.includes("Connecting to Studio gateway"), strip);
  check("walk: switch: no confirmation without a message waiting", !(await p.evaluate(() => document.querySelector("#confirm-dialog").open)));
  await p.waitForTimeout(1100);
  const after = await rail(p);
  check("walk: switch: Studio's bots only", after.includes("Marlow") && after.includes("Pip") && !after.includes("Otto") && !after.includes("Juniper"), after);
  check("walk: switch: the footer names Studio gateway", (await footer(p)).includes("Studio gateway") && (await footer(p)).includes("Connected"));
  check("walk: switch: announced after the hello", (await announced(p)) === "Switched to Studio gateway");
  await click(p, ".gateway-pill");
  check("walk: switch: Studio is checked", (await p.evaluate(() => document.querySelector('#gateway-menu [data-gw="studio"]').getAttribute("aria-checked"))) === "true");
  check("walk: switch: no page errors", p.errors.length === 0, p.errors.join(" | "));
  await p.close();
}
{
  const p = await open("waiting=1");
  await click(p, ".gateway-pill");
  await click(p, '#gateway-menu [data-gw="studio"]');
  const [ok, miss] = await has(p, confirm, ["Switch to Studio gateway?", "1 message to Otto hasn't been sent to Home gateway yet. Switching discards it: it isn't kept as a draft. Runs on Home gateway keep going.", "Cancel", "Switch"]);
  check("walk: switch, a message waiting: the confirmation names it", ok, miss);
  check("walk: switch, a message waiting: focus on Cancel", (await p.evaluate(() => document.activeElement?.textContent.trim())) === "Cancel");
  await press(p, "button", "Cancel");
  check("walk: switch, Cancel: Home still in use", (await rail(p)).includes("Otto") && (await footer(p)).includes("Home gateway"));
  await click(p, ".gateway-pill");
  await click(p, '#gateway-menu [data-gw="studio"]');
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 1200);
  check("walk: switch, a message waiting: Switch leads to Studio in use", (await rail(p)).includes("Marlow") && (await footer(p)).includes("Studio gateway"));
  await p.close();
}
{
  const p = await open("switchfail=1");
  await click(p, ".gateway-pill");
  await click(p, '#gateway-menu [data-gw="studio"]', 1200);
  const [ok, miss] = await has(p, "#status-strip", ["Can't reach Studio gateway", "it didn't answer", "Retry", "Back to Home gateway"]);
  check("walk: switch fails: the strip says so, with Retry and Back", ok, miss);
  check("walk: switch fails: nothing of either gateway shows", !(await rail(p)).includes("Otto") && !(await rail(p)).includes("Marlow"));
  check("walk: switch fails: announced", (await announced(p)) === "Couldn't reach Studio gateway");
  await click(p, '#status-strip [data-s="switch-back"]', 1200);
  check("walk: switch fails: Back to Home gateway leads to Home in use", (await rail(p)).includes("Otto") && (await footer(p)).includes("Home gateway"));
  await p.close();
}

// Part 4: adding (section 5) --------------------------------------------------------------------------------

async function addWalk(name, choice, words, rows, railWord) {
  const p = await open("open=settings&section=gateways");
  await press(p, "button", "Add gateway…");
  const [ok0, miss0] = await has(p, "#s-stand", ["Prototype stand-in", "Adding a gateway. Home gateway stays saved; Cancel goes back to it.", "Where does OpenClaw run?"]);
  check(`walk: add, ${name}: the setup stand-in says what stays`, ok0, miss0);
  await press(p, "button", choice, 1300);
  const [ok, miss] = await has(p, settings, words);
  const count = await p.evaluate(() => document.querySelectorAll('[data-testid="gateway-list"] > li').length);
  check(`walk: add, ${name}: the result`, ok && count === rows, `missing: ${miss}; rows ${count}`);
  check(`walk: add, ${name}: the rail`, (await rail(p)).includes(railWord), await rail(p));
  check(`walk: add, ${name}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
  await p.close();
}
await addWalk("a new gateway", "Paired: a new gateway", ["Added Lab gateway", "Clawtrate is connected to it, read-only. Home gateway stays saved: switch back from the gateway menu.", "198.51.100.7 · In use"], 3, "Juniper");
await addWalk("the same gateway", "Paired: the same gateway", ["Home gateway is already here", "This address leads to Home gateway. Clawtrate keeps its saved pairing and didn't add a second entry.", "gateway.local · In use"], 2, "Otto");
await addWalk("no identity", "Paired: no identity", ["Added 198.51.100.7", "didn't say who it is, so Clawtrate keeps it under its address."], 3, "Pip");
await addWalk("setup failed", "Setup failed", ["Nothing was added", "Clawtrate is connected to Home gateway again."], 2, "Otto");
await addWalk("cancelled", "Cancel", ["Nothing was added", "Clawtrate is connected to Home gateway again."], 2, "Otto");
{
  const p = await open("waiting=1");
  await click(p, ".gateway-pill");
  await click(p, '#gateway-menu [data-s="add"]');
  const [ok, miss] = await has(p, confirm, ["Add a gateway?", "1 message to Otto hasn't been sent to Home gateway yet.", "which discards the message: it isn't kept as a draft."]);
  check("walk: add from the menu with a message waiting: asks first", ok, miss);
  await p.close();
}

// Part 5: removing (section 7) ------------------------------------------------------------------------------

const REMOVED_WORDS = [
  "Remove Studio gateway from this device?",
  "Nothing on the gateway changes.",
  "Removed from this device",
  "Its pairing: the device token Clawtrate keeps for its route",
  "Its route: devbox, over SSH, with the key Clawtrate pinned for it",
  "Drafts in 2 tasks",
  "How you arranged its bots in the rail, and the task last open",
  "Stays",
  "On Studio gateway: its bots, tasks, accounts and settings. Nothing there changes.",
  "On Studio gateway: this device's record, device 9c2e41. To remove it, run this on the gateway's computer:",
  "openclaw devices remove 9c2e41d07a3b5f18",
  "This device's key. Home gateway knows this device by it too.",
  "Clawtrate stops its forward to devbox. OpenClaw on devbox keeps running.",
];
{
  const p = await open("open=settings&section=gateways&gw=studio");
  await press(p, "button", "Remove…");
  const [ok, miss] = await has(p, confirm, REMOVED_WORDS);
  check("walk: remove another gateway: the confirmation lists what goes and what stays", ok, miss);
  check("walk: remove another gateway: no record checkbox for a gateway not in use", (await p.locator("#confirm-dialog [data-s-record]").count()) === 0);
  check("walk: remove: focus on Cancel", (await p.evaluate(() => document.activeElement?.textContent.trim())) === "Cancel");
  check("walk: remove: the dialog is modal", await p.evaluate(() => document.querySelector("#confirm-dialog").matches(":modal")));
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok2, miss2] = await has(p, settings, ["Studio gateway is removed from this device", "Its pairing: the device token Clawtrate keeps for its route", "Removed", "Stays"]);
  const rows = await p.evaluate(() => document.querySelectorAll('[data-testid="gateway-list"] > li').length);
  check("walk: remove another gateway: the result, one gateway left", ok2 && rows === 1, `missing ${miss2}; rows ${rows}`);
  check("walk: remove another gateway: announced", (await announced(p)) === "Studio gateway is removed from this device");
  await p.close();
}
{
  const p = await open("open=settings&section=gateway");
  await press(p, "button", "Remove this gateway…");
  const [ok, miss] = await has(p, confirm, ["Remove Home gateway from this device?", "Nothing on the gateway changes unless you tick the box below.", "Also remove this device's record from Home gateway", "This device's key. Studio gateway knows this device by it too."]);
  check("walk: remove the gateway in use, with admin: the record checkbox", ok, miss);
  check("walk: remove the gateway in use, with admin: unticked", !(await p.locator("#confirm-dialog [data-s-record]").isChecked()));
  await p.locator("#confirm-dialog [data-s-record]").check();
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok2, miss2] = await has(p, settings, ["Home gateway is removed from this device", "This device's record on Home gateway", "Home gateway removed it", "Not connected. Choose a gateway to use.", "Studio gateway"]);
  check("walk: remove the gateway in use: removed, not connected, choose", ok2, miss2);
  check("walk: remove the gateway in use: the rail says not connected", (await rail(p)).includes("Not connected"));
  await press(p, "button", "Switch to Studio gateway", 1200);
  check("walk: remove the gateway in use: then Switch leads to Studio", (await rail(p)).includes("Marlow"));
  await p.close();
}
{
  const p = await open("open=settings&section=gateway&access=write");
  await press(p, "button", "Remove this gateway…");
  check("remove, below admin: no checkbox; the record stays with its command", (await p.locator("#confirm-dialog [data-s-record]").count()) === 0 && (await text(p, confirm)).includes("openclaw devices remove 9c2e41d07a3b5f18"));
  await p.close();
}
{
  const p = await open("remove=home&rmfail=remote&waiting=1");
  const [ok0] = await has(p, confirm, ["1 message to Otto that hasn't been sent yet"]);
  check("remove with a message waiting: the confirmation names it", ok0);
  await p.locator("#confirm-dialog [data-s-record]").check();
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok, miss] = await has(p, settings, ["Home gateway didn't remove this device's record", "Nothing was removed. Home gateway said: the request was refused.", "Remove from this device only", "Cancel"]);
  check("walk: remove, the gateway refuses: nothing removed", ok, miss);
  check("walk: remove, the gateway refuses: Home still in use", (await rail(p)).includes("Otto"));
  await press(p, "button", "Remove from this device only", 200);
  const [ok2, miss2] = await has(p, settings, ["Home gateway is removed from this device", "On Home gateway: this device's record, device 9c2e41."]);
  check("walk: remove, the gateway refuses: from this device only, the record stays", ok2, miss2);
  await p.close();
}
{
  const p = await open("remove=home&rmfail=unknown");
  await p.locator("#confirm-dialog [data-s-record]").check();
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok, miss] = await has(p, settings, ["Clawtrate can't tell whether Home gateway removed this device's record", "Nothing else was removed. Look for this device in Home gateway's device list on the gateway's computer.", "Remove from this device only"]);
  check("walk: remove, no answer from the gateway: not claimed as removed, nothing else removed", ok && (await rail(p)).includes("Otto") && !(await text(p, settings)).includes("Home gateway removed it"), miss);
  await press(p, "button", "Remove from this device only", 200);
  const [ok2, miss2] = await has(p, settings, ["Home gateway is removed from this device", "On Home gateway: this device's record, device 9c2e41."]);
  check("walk: remove, no answer, from this device only: the record is listed as staying", ok2 && !(await text(p, settings)).includes("Home gateway removed it"), miss2);
  await p.close();
}
{
  const p = await open("remove=home");
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const t = await text(p, settings);
  check("walk: remove the gateway in use without the box: the record is listed as staying, never as removed", t.includes("On Home gateway: this device's record, device 9c2e41.") && !t.includes("Home gateway removed it"));
  await p.close();
}
{
  const p = await open("remove=studio&rmfail=local");
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok, miss] = await has(p, settings, ["Couldn't remove everything", "Still on this device", "Not tried", "Try again"]);
  check("walk: remove, a local step fails: each item marked", ok, miss);
  check("walk: remove, a local step fails: Studio still listed", (await p.evaluate(() => document.querySelectorAll('[data-testid="gateway-list"] > li').length)) === 2);
  await press(p, "button", "Try again", 200);
  check("walk: remove, Try again: removed", (await text(p, settings)).includes("Studio gateway is removed from this device"));
  await p.close();
}
{
  const p = await open("remove=studio");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(100);
  check("remove: Escape closes the confirmation and removes nothing", !(await p.evaluate(() => document.querySelector("#confirm-dialog").open)) && (await p.evaluate(() => window.settingsProto.S.order.length)) === 2);
  await p.close();
}

// Part 6: Appearance, System (sections 8 and 9) --------------------------------------------------------------

{
  const p = await open("open=settings&section=appearance");
  const [ok, miss] = await has(p, settings, ["Theme", "Follow system", "Light", "Dark", "Your messages", "Accent", "Neutral", "Kept on this device."]);
  check("Appearance: its words", ok, miss);
  await press(p, "radio", "Dark");
  check("walk: Appearance, Dark: the page is dark, announced", (await p.evaluate(() => document.documentElement.dataset.theme)) === "dark" && (await announced(p)) === "Theme: Dark");
  await press(p, "radio", "Neutral");
  check("walk: Appearance, Neutral: neutral bubbles, announced", (await p.evaluate(() => document.documentElement.dataset.bubbles)) === "neutral" && (await announced(p)) === "Your messages: Neutral");
  check("Appearance: one tab stop per group", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .seg")].every((g) => [...g.querySelectorAll("[role=radio]")].filter((r) => r.tabIndex === 0).length === 1)));
  await p.close();
}
{
  const p = await open("open=settings&section=appearance&savefail=1");
  await press(p, "radio", "Light");
  check("Appearance, the save failed: applies until Clawtrate closes", (await text(p, settings)).includes("Clawtrate couldn't save this. It applies until you close Clawtrate."));
  await p.close();
}
{
  const p = await open("open=settings&section=system");
  const [ok, miss] = await has(p, settings, ["Check spelling while typing", "Uses macOS's own spelling checker, in the languages macOS is set to.", "Use hardware acceleration", "Turn off if Clawtrate draws badly or flickers on this computer."]);
  check("System, macOS: its words", ok, miss);
  const spell = p.locator('#settings-dialog [data-s="spell"]');
  check("System: spelling on by default, a switch", (await spell.getAttribute("role")) === "switch" && (await spell.getAttribute("aria-checked")) === "true");
  await spell.click();
  await p.waitForTimeout(100);
  check("walk: spelling off: read back and announced", (await p.locator('#settings-dialog [data-s="spell"]').getAttribute("aria-checked")) === "false" && (await text(p, settings)).includes("Spelling isn't checked.") && (await announced(p)) === "Spelling isn't checked");
  await p.locator('#settings-dialog [data-s="hw"]').click();
  await p.waitForTimeout(100);
  check("walk: hardware acceleration off: until a restart", (await text(p, settings)).includes("Turns off when Clawtrate restarts.") && (await announced(p)) === "Hardware acceleration turns off when Clawtrate restarts");
  await press(p, "button", "Restart now");
  check("walk: Restart now: off, read back after the restart", (await text(p, settings)).includes("Off. Clawtrate draws without the graphics hardware.") && !(await text(p, settings)).includes("Restart now"));
  await p.close();
}
await stateWords("System, Windows: the dictionary's language", "open=settings&section=system&os=windows", settings, ["Checks English (United States)."]);
await stateWords("System, Windows: downloading", "open=settings&section=system&os=windows&spell=downloading", settings, ["Uses a dictionary for English (United States), which Clawtrate downloads once."]);
{
  const p = await open("open=settings&section=system&os=windows&spell=failed");
  check("System, Windows: the download failed", (await text(p, settings)).includes("Couldn't download the dictionary for English (United States). Spelling isn't checked."));
  await press(p, "button", "Try again", 1100);
  check("walk: the dictionary, Try again: ready", (await text(p, settings)).includes("Checks English (United States).") && (await announced(p)) === "Spelling is checked");
  await p.close();
}
await stateWords("System: turned on again, not restarted", "open=settings&section=system&hw=off", settings, ["Off. Clawtrate draws without the graphics hardware."]);
{
  const p = await open("open=settings&section=system&hw=pending&waiting=1");
  await press(p, "button", "Restart now");
  const [ok, miss] = await has(p, confirm, ["Restart Clawtrate?", "1 message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft. Runs on Home gateway keep going."]);
  check("walk: Restart now with a message waiting: asks first", ok, miss);
  await p.close();
}

// Part 7: Updates and Update required (sections 10 and 11) ---------------------------------------------------

{
  const p = await open("open=settings&section=updates");
  const [ok, miss] = await has(p, settings, ["Version", "Clawtrate 0.1.0", "This copy can't check for updates: no update source is set up for it."]);
  check("walk: Updates, no source: its words", ok, miss);
  check("Updates, no source: no Check for Updates, no switch, no track", !/Check for Updates|Automatic Updates|Update Track|Stable/.test(await text(p, settings)));
  await p.close();
}
await stateWords("Updates, a development build", "open=settings&section=updates&build=dev", settings, ["A development build. It doesn't update itself."]);
{
  const p = await open("open=settings&section=updates&os=linux&feed=1");
  const t = await text(p, settings);
  check("Updates, Linux: the package manager, no switch, no button", t.includes("Updates are managed by your package manager.") && t.includes("When a Linux package is built") && !/Check for Updates|Automatic Updates/.test(t));
  await p.close();
}
{
  const p = await open("open=settings&section=updates&feed=1");
  const [ok, miss] = await has(p, settings, [
    "When releases are published: a future example. No update source exists today.",
    "Checked at 9:05 AM",
    "Check for Updates",
    "Automatic Updates",
    "Install a downloaded update by itself while you're away: when the screen is locked, the computer has been idle for 10 minutes, and no run is active on the gateway Clawtrate is using.",
    "Clawtrate can't tell when a screen saver is on, so only a locked screen counts.",
  ]);
  check("Updates, with a source: labelled as a future example, the rule's words", ok, miss);
  await press(p, "button", "Check for Updates");
  check("walk: Check for Updates: checking", (await text(p, settings)).includes("Checking for updates…"));
  await p.waitForTimeout(1000);
  check("walk: Check for Updates: up to date, announced", (await text(p, settings)).includes("You're up to date. Checked at 5:41 PM.") && (await announced(p)) === "You're up to date");
  const auto = p.locator('#settings-dialog [data-s="auto"]');
  check("Updates: Automatic Updates off by default", (await auto.getAttribute("aria-checked")) === "false");
  await p.close();
}
{
  const p = await open("open=settings&section=updates&feed=1&next=update&waiting=1");
  await press(p, "button", "Check for Updates", 1100);
  check("walk: an update: downloading, no percentage", (await text(p, settings)).includes("Downloading Clawtrate 0.2.0…") && !(await text(p, settings)).includes("%"));
  await p.waitForTimeout(1000);
  check("walk: an update: ready, installs when Clawtrate restarts", (await text(p, settings)).includes("Clawtrate 0.2.0 is ready. It installs when Clawtrate restarts."));
  await press(p, "button", "Restart to Update");
  const [ok, miss] = await has(p, confirm, ["Restart to update?", "1 message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft."]);
  check("walk: Restart to Update with a message waiting: asks first", ok, miss);
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  check("walk: Restart to Update: Clawtrate 0.2.0", (await text(p, settings)).includes("Clawtrate 0.2.0") && (await text(p, settings)).includes("You're up to date"));
  await p.close();
}
{
  const p = await open("required=client");
  const [ok, miss] = await has(p, "#s-required", ["Update required", "Home gateway speaks protocol 5. This version of Clawtrate speaks protocol 4, so it can't use it.", "This copy can't update itself. Install a newer Clawtrate to use Home gateway.", "Switch gateway", "Try again"]);
  check("walk: Update required: the whole window, its words", ok && (await p.evaluate(() => document.querySelector(".shell").hidden)), miss);
  check("Update required: no Update button without a source", (await p.getByRole("button", { name: "Update", exact: true }).count()) === 0);
  await press(p, "button", "Switch gateway");
  await press(p, "button", "Studio gateway devbox, over SSH", 1200);
  check("walk: Update required, Switch gateway: Studio in use", (await rail(p)).includes("Marlow") && !(await p.evaluate(() => document.querySelector(".shell").hidden)));
  await p.close();
}
await stateWords("Update required, with a source: Update", "required=client&feed=1", "#s-required", ["Update required", "Update"]);
{
  const p = await open("required=client", { width: 390, height: 844 });
  const t = await text(p, "#s-required");
  check("Update required, iPhone: the App Store or TestFlight", t.includes("Update Clawtrate in the App Store, or in TestFlight if you test it there.") && !t.includes("This copy can't update itself"));
  await p.close();
}
{
  const p = await open("required=client&gateways=one");
  check("Update required, one gateway: no Switch gateway", !(await text(p, "#s-required")).includes("Switch gateway"));
  await p.close();
}
{
  const p = await open("required=gateway&open=settings&section=gateway");
  const [ok, miss] = await has(p, "#status-strip", ["Can't use Home gateway", "it speaks an older protocol", "Switch gateway"]);
  const [ok2, miss2] = await has(p, settings, ["This gateway speaks another protocol", "Update OpenClaw on the gateway's computer to use it with this version."]);
  check("a gateway too old: not Update required; the strip and the Gateway pane say so", ok && ok2 && (await p.evaluate(() => document.querySelector("#s-required").hidden)), `${miss} ${miss2}`);
  await p.close();
}

// Part 8: Compact (section 13) --------------------------------------------------------------------------------

const J1 = "bot=juniper&task=j1&panel=open&tab=details";
{
  const p = await open(J1);
  const [ok, miss] = await has(p, '[data-testid="context-group"]', ["Context", "Compact asks the gateway to replace older turns in Juniper's context with a summary. Every turn stays here.", "Compact"]);
  check("Compact: the Context group in Details", ok, miss);
  const before = await p.locator("#transcript [data-testid=transcript-turn]").count();
  await press(p, "button", "Compact");
  check("walk: Compact: compacting, in the transcript and Details", (await text(p, "#transcript")).includes("Compacting Juniper's context…") && (await text(p, "#panel-details")).includes("Compacting…"));
  check("walk: Compact: nothing announced before the reply", (await announced(p)) !== "Compacted");
  await p.waitForTimeout(1400);
  const line = await text(p, '[data-testid="compacted"]');
  check("walk: Compact: the compacted line", line.includes("Context compacted · 9.7k → 2.1k tokens") && line.includes("3 earlier turns") && (await announced(p)) === "Compacted", line);
  const toggle = p.locator(".s-compacted-toggle");
  check("walk: Compact: the earlier turns folded, a button with aria-expanded", (await toggle.getAttribute("aria-expanded")) === "false" && (await p.locator("#s-fold-j1").isHidden()) && before === 6);
  await toggle.click();
  await p.waitForTimeout(80);
  check("walk: Compact: the fold opens", (await toggle.getAttribute("aria-expanded")) === "true" && (await p.locator("#s-fold-j1").isVisible()) && (await text(p, "#s-fold-j1")).includes("Juniper's context now holds a summary of these and its most recent messages."));
  check("Compact: no /compact bubble", !(await text(p, "#transcript")).includes("/compact"));
  await p.close();
}
async function compactReply(name, reply, words) {
  const p = await open(`${J1}&reply=${reply}`);
  await press(p, "button", "Compact", 1500);
  const [ok, miss] = await has(p, "#transcript", words);
  check(`walk: Compact, ${name}`, ok && p.errors.length === 0, miss);
  return p;
}
{
  const p = await compactReply("the gateway failed it", "failed", ["Couldn't compact. Juniper's context is as it was.", "Show the gateway's reply"]);
  check("Compact, failed: announced", (await announced(p)) === "Couldn't compact");
  await press(p, "button", "Show the gateway's reply");
  check("Compact, failed: the reply opens as text", (await p.locator("#s-reply").isVisible()) && (await text(p, "#s-reply")).includes("Compaction failed"));
  await p.close();
}
await (await compactReply("nothing to compact", "skipped", ["Nothing to compact yet."])).close();
await (await compactReply("a run was stopped", "stopped", ["Couldn't compact.", "The gateway stopped the run that was going. Send that message again."])).close();
{
  const p = await open(`${J1}&compact=running`);
  const t = await text(p, '[data-testid="context-group"]');
  check("Compact while a run is active: disabled, and why", t.includes("Compact is available when this run ends. The gateway would stop a run still going a minute after you compact.") && (await p.locator('[data-testid="context-group"] button').isDisabled()), t);
  await p.close();
}
{
  const p = await open(`${J1}&access=read`);
  const t = await text(p, '[data-testid="context-group"]');
  check("Compact, read-only: no Compact, the access bar", t.includes("Compacting sends a message, which needs this device to be able to send.") && t.includes("Request access") && (await p.getByRole("button", { name: "Compact", exact: true }).count()) === 0, t);
  await press(p, "button", "Request access", 200);
  check("walk: Compact, read-only, Request access: Compact appears", (await p.getByRole("button", { name: "Compact", exact: true }).count()) === 1);
  await p.close();
}

// Part 9: low disk (section 14) ---------------------------------------------------------------------------------

{
  const p = await open("disk=node");
  const n = p.locator('[data-testid="disk-note"]');
  const [ok, miss] = await has(p, '[data-testid="disk-note"]', ["Otto is set to run commands on media-box, which has 2.1 GB free of 512 GB, as of 5:40 PM.", "Clawtrate deletes nothing. Whether Otto asks before it deletes a file depends on its command rules.", "Show the computer", "Otto's rules"]);
  check("low disk: the note's words", ok && (await n.getAttribute("role")) === "region" && (await n.getAttribute("aria-label")) === "Disk space", miss);
  check("low disk: no Delete or Clean up", !/Delete|Clean up|Free space now/.test(await text(p, '[data-testid="disk-note"]')));
  check("low disk: directly above the composer", await p.evaluate(() => document.querySelector('[data-testid="disk-note"]').nextElementSibling?.id === "composer"));
  await press(p, "button", "Show the computer");
  check("walk: low disk, Show the computer: the Computer tab", (await p.locator("#tab-computer").getAttribute("aria-selected")) === "true");
  await press(p, "button", "Close the disk note");
  check("walk: low disk, closed: gone", (await p.locator('[data-testid="disk-note"]').count()) === 0);
  await p.close();
}
await stateWords("low disk, the gateway's machine", "disk=gateway", '[data-testid="disk-note"]', ["Otto is set to run commands on the gateway's machine. The volume with its workspace has 4.2 GB free of 994 GB, as of 5:40 PM."]);
{
  const p = await open("disk=node");
  await click(p, '#bot-list .bot[data-bot="juniper"]', 200);
  check("low disk: another bot's task shows no note", (await p.locator('[data-testid="disk-note"]').count()) === 0);
  await p.close();
}

// Part 10: keyboard, widths, themes -----------------------------------------------------------------------------

{
  const p = await open("open=settings&section=gateways");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(100);
  check("keyboard: Escape closes Settings", !(await p.evaluate(() => document.querySelector("#settings-dialog").open)));
  await click(p, ".gateway-pill");
  await p.keyboard.press("ArrowUp");
  await p.keyboard.press("ArrowUp");
  const focused = await p.evaluate(() => document.activeElement?.textContent.trim());
  check("keyboard: the gateway menu's items are reached with arrows", typeof focused === "string" && focused.length > 0);
  await p.close();
}
for (const width of [1100, 800]) {
  for (const section of ["gateways", "appearance", "system", "updates"]) {
    const p = await open(`open=settings&section=${section}&feed=1`, { width });
    const sideways = await p.evaluate(() => {
      const el = document.querySelector("#settings-dialog .b-section-body");
      return el.scrollWidth > el.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1;
    });
    check(`width ${width}: ${section} has no sideways scroll`, !sideways);
    await p.close();
  }
}
for (const theme of ["light", "dark"]) {
  const p = await open("open=settings&section=gateways&remove=studio", { theme });
  check(`theme ${theme}: Settings and the removal draw without errors`, p.errors.length === 0 && (await p.evaluate((t) => document.documentElement.dataset.theme === t, theme)), p.errors.join(" | "));
  await p.close();
}
{
  const p = await open(`${J1}&compact=compacting&motion=reduce`);
  check("motion: reduced, the page draws", p.errors.length === 0 && (await p.evaluate(() => document.documentElement.dataset.motion)) === "reduce");
  await p.close();
}

await b.close();
console.log(out.join("\n"));
console.log(`${out.length - failed} of ${out.length} checks passed`);
process.exit(failed ? 1 : 0);
