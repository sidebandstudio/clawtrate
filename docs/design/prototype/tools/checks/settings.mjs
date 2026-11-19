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

for (const [section, words] of [
  ["gateway", "Saved on this device. Read-only access lets you switch, add or remove saved connections here."],
  ["gateways", "Saved on this device. Read-only access lets you switch, add or remove saved connections here."],
  ["appearance", "Applies on this device."],
  ["system", "Applies on this device."],
  ["updates", "Applies on this device."],
]) {
  const p = await open(`open=settings&section=${section}&access=read`);
  check(`ownership: ${section} says where it lives and what read-only can do`, (await text(p, '#settings-dialog [data-testid="owner-line"]')) === words);
  await p.close();
}
{
  const p = await open("open=settings&section=gateways&host=web");
  check("ownership: on the web preview, the shared host is named", (await text(p, '#settings-dialog [data-testid="owner-line"]')).startsWith("Saved on this preview's host, shared by every browser that uses it."));
  await p.close();
}

// Part 2: Your gateways and a gateway's page --------------------------------------------------------------

await stateWords("Your gateways: its words and rows", "open=settings&section=gateways", settings, [
  "Clawtrate saves a separate connection for each gateway and uses one at a time.",
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
  "Last paired here · Nov 18, 4:02 PM",
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
  "Its saved connection: its route, devbox, over SSH, with the key Clawtrate pinned for it and its SSH settings",
  "Its route's device token and the access it holds",
  "Drafts in 2 tasks",
  "Its preferences on this device: how its bots are arranged, the open bot and task, what you read, and the bots you unfolded",
  "Stays",
  "On Studio gateway: its bots, tasks, accounts and settings. Nothing there changes.",
  "On Studio gateway: this device's record, device 9c2e41. Clawtrate doesn't ask the gateway to remove it. To remove it, run this on the gateway's computer:",
  "openclaw devices remove 9c2e41d07a3b5f18",
  "This device's key. Home gateway knows this device by it too.",
  "Clawtrate's own settings on this device: Appearance, System and Updates.",
  "Clawtrate stops its forward to devbox. OpenClaw on devbox keeps running.",
];
const recordLine = (p) => text(p, '#settings-dialog [data-testid="record-line"]');
{
  const p = await open("open=settings&section=gateways&gw=studio");
  await press(p, "button", "Remove…");
  const [ok, miss] = await has(p, confirm, REMOVED_WORDS);
  check("walk: remove another gateway: the confirmation names each record that goes and what stays", ok, miss);
  check("walk: remove another gateway: no record checkbox for a gateway not in use", (await p.locator("#confirm-dialog [data-s-record]").count()) === 0);
  check("walk: remove: focus on Cancel", (await p.evaluate(() => document.activeElement?.textContent.trim())) === "Cancel");
  check("walk: remove: the dialog is modal", await p.evaluate(() => document.querySelector("#confirm-dialog").matches(":modal")));
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok2, miss2] = await has(p, settings, ["Studio gateway is removed from this device", "Its route's device token and the access it holds", "Removed", "Stays"]);
  const rows = await p.evaluate(() => document.querySelectorAll('[data-testid="gateway-list"] > li').length);
  check("walk: remove another gateway: the result, one gateway left", ok2 && rows === 1, `missing ${miss2}; rows ${rows}`);
  check("walk: remove another gateway: the gateway was not asked, and says so", (await recordLine(p)).includes("Clawtrate did not ask the gateway to remove this device's record."));
  check("walk: remove another gateway: announced", (await announced(p)) === "Studio gateway is removed from this device");
  await p.close();
}
{
  const p = await open("open=settings&section=gateway");
  await press(p, "button", "Remove this gateway…");
  const [ok, miss] = await has(p, confirm, ["Remove Home gateway from this device?", "Nothing on the gateway changes unless you tick the box below.", "Also remove this device's record from Home gateway. That ends this device's access to Home gateway through every route.", "Its connection on this device, open or waiting", "This device's key. Studio gateway knows this device by it too."]);
  check("walk: remove the gateway in use, with admin: the record checkbox", ok, miss);
  check("walk: remove the gateway in use, with admin: unticked", !(await p.locator("#confirm-dialog [data-s-record]").isChecked()));
  await p.locator("#confirm-dialog [data-s-record]").check();
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok2, miss2] = await has(p, settings, ["Home gateway is removed from this device", "Gateway removed this device's record. That ends this device's access to Home gateway through every route.", "Not connected. Choose a gateway to use.", "Studio gateway"]);
  check("walk: remove the gateway in use, a matching answer: the record removed, not connected, choose", ok2, miss2);
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
  const p = await open("remove=home&host=web");
  check("remove on the web preview: every browser of that host is named", (await text(p, confirm)).includes("This preview's host is shared: removing it here removes it for every browser that uses this host."));
  await p.close();
}
{
  const p = await open("remove=home&rmfail=remote&waiting=1");
  const [ok0] = await has(p, confirm, ["1 message to Otto that hasn't been sent yet"]);
  check("remove with a message waiting: the confirmation names it", ok0);
  await p.locator("#confirm-dialog [data-s-record]").check();
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok, miss] = await has(p, settings, ["Home gateway refused to remove this device's record", "Nothing was removed. Home gateway said: the request was refused.", "Remove from this device only", "Cancel"]);
  check("walk: remove, the gateway refuses: nothing removed", ok, miss);
  check("walk: remove, the gateway refuses: Home still in use", (await rail(p)).includes("Otto"));
  await press(p, "button", "Remove from this device only", 200);
  const r = await recordLine(p);
  check("walk: remove, the gateway refuses: from this device only, the record stays, refused", (await text(p, settings)).includes("Home gateway is removed from this device") && r.includes("Home gateway refused to remove it."), r);
  await p.close();
}
{
  const p = await open("remove=home&rmfail=unknown");
  await p.locator("#confirm-dialog [data-s-record]").check();
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const [ok, miss] = await has(p, settings, ["Gateway record could not be confirmed", "Clawtrate asked Home gateway to remove this device's record and got no answer it can read.", "Nothing else was removed.", "Remove from this device only"]);
  check("walk: remove, an unclear answer: neither removed nor kept is claimed", ok && (await rail(p)).includes("Otto") && !(await text(p, settings)).includes("Gateway removed this device's record"), miss);
  await press(p, "button", "Remove from this device only", 200);
  const r = await recordLine(p);
  check("walk: remove, an unclear answer, then this device only: still could not be confirmed, to the end", r.includes("Gateway record could not be confirmed.") && !r.includes("this device's record, device 9c2e41.") && !(await text(p, settings)).includes("Gateway removed this device's record"), r);
  await p.close();
}
{
  const p = await open("remove=home");
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  const r = await recordLine(p);
  check("walk: remove the gateway in use without the box: the gateway wasn't asked, never removed", r.includes("Clawtrate did not ask the gateway to remove this device's record.") && !(await text(p, settings)).includes("Gateway removed this device's record"), r);
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
  const [ok, miss] = await has(p, settings, ["Theme", "Follow system", "Light", "Dark", "Your messages", "Accent", "Neutral", "Applies on this device."]);
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
{
  const p = await open("open=settings&section=system&os=windows");
  const t = await text(p, settings);
  check("System, Windows: spelling unavailable in this build, no switch, nothing downloaded", t.includes("Spelling is unavailable in this build.") && (await p.locator('#settings-dialog [data-s="spell"]').count()) === 0 && !/download/i.test(t));
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
  const p = await open("open=settings&section=updates&feed=1&install=1");
  const [ok, miss] = await has(p, settings, [
    "When releases are published: a future example. No update source exists today.",
    "Not checked yet.",
    "Check for Updates",
    "Checks updates.example.com for a newer build, only when you choose to.",
  ]);
  check("Updates, with a source: a future example; the source named before any check", ok, miss);
  await press(p, "button", "Check for Updates");
  check("walk: Check for Updates: checking the named source", (await text(p, settings)).includes("Checking updates.example.com…"));
  await p.waitForTimeout(1000);
  check("walk: Check for Updates, nothing newer: not 'up to date'", (await text(p, settings)).includes("No newer version was offered for this build by its update source. Checked at 5:41 PM.") && !/up to date/i.test(await text(p, settings)));
  await p.close();
}
{
  const p = await open("open=settings&section=updates&feed=1");
  check("Updates, a build that can't install itself says so", (await text(p, settings)).includes("This build can't install updates itself."));
  check("Updates: automatic restart unavailable, and no switch for it", (await text(p, settings)).includes("Automatic restart is unavailable in this build.") && (await p.locator('#settings-dialog [role="switch"]').count()) === 0 && !(await text(p, settings)).includes("screen saver"));
  await p.close();
}
{
  const p = await open("open=settings&section=updates&feed=1&upd=ready");
  const t = await text(p, settings);
  check("Updates, downloaded but not installable: no Restart to Update", t.includes("This build can't install it itself.") && !t.includes("Restart to Update"));
  await p.close();
}
for (const [next, words] of [["failcheck", "Couldn't check for updates."], ["nofile", "The update source has no file for this system."]]) {
  const p = await open(`open=settings&section=updates&feed=1&install=1&next=${next}`);
  await press(p, "button", "Check for Updates", 1100);
  check(`walk: Check for Updates, ${next}: its own words`, (await text(p, settings)).includes(words));
  await p.close();
}
{
  const p = await open("open=settings&section=updates&feed=1&install=1&next=update&dl=fail");
  await press(p, "button", "Check for Updates", 1100);
  await press(p, "button", "Download", 1100);
  check("walk: a failed download has its own words", (await text(p, settings)).includes("Couldn't download the update. Try again."));
  await p.close();
}
{
  const p = await open("open=settings&section=updates&feed=1&install=1&next=update&waiting=1");
  await press(p, "button", "Check for Updates", 1100);
  check("walk: an update: offered, then a separate choice to download", (await text(p, settings)).includes("Clawtrate 0.2.0 is offered by the update source.") && (await p.getByRole("button", { name: "Download", exact: true }).count()) === 1);
  await press(p, "button", "Download");
  check("walk: an update: downloading, with what has arrived", (await text(p, settings)).includes("Downloading Clawtrate 0.2.0… 41 of 120 MB"));
  await p.waitForTimeout(1000);
  check("walk: an update: ready to install, only with the installer's confirmation", (await text(p, settings)).includes("Ready to install.") && !/verified|secure/i.test(await text(p, settings)));
  await press(p, "button", "Restart to Update");
  const [ok, miss] = await has(p, confirm, ["Restart to update?", "1 message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft."]);
  check("walk: Restart to Update with a message waiting: asks first", ok, miss);
  await click(p, '#confirm-dialog [data-s="confirm-ok"]', 200);
  check("walk: Restart to Update: the running version after the restart", (await text(p, settings)).includes("Clawtrate 0.2.0 is running."));
  await p.close();
}
// F-518: one walk, parameterized by direction and by the number of saved gateways.
for (const [dir, theirs] of [["client", 5], ["gateway", 3]]) {
  for (const count of ["one", "two"]) {
    const name = `refusal, ${dir === "client" ? "this build older" : "gateway older"}, ${count} saved`;
    const p = await open(`required=${dir}${count === "one" ? "&gateways=one" : ""}`);
    const lead = `The address saved for Home gateway replied with protocol ${theirs}. This version of Clawtrate speaks protocol 4.`;
    const words = dir === "client"
      ? [`Can't use Home gateway`, lead, "Update required to use Home gateway. Other gateways aren't affected.", "This copy can't update itself. A newer Clawtrate is needed to use Home gateway.", "Try again", "Your gateways"]
      : [`Can't use Home gateway`, lead, "Update OpenClaw on the gateway's computer to use it with this version.", "Try again", "Your gateways"];
    const [ok, miss] = await has(p, '[data-testid="refusal"]', words);
    check(`F-518 ${name}: that connection's words`, ok, miss);
    check(`F-518 ${name}: the app stays; the rail empty; no composer`, !(await p.evaluate(() => document.querySelector(".shell").hidden)) && !/Otto|Juniper/.test(await rail(p)) && (await p.locator("#composer").isHidden()));
    check(`F-518 ${name}: the strip, with Try again`, (await text(p, "#status-strip")).includes(`Can't use Home gateway`) && (await text(p, "#status-strip")).includes(`protocol ${theirs}`));
    check(`F-518 ${name}: no Update, no product version unlabelled`, (await p.getByRole("button", { name: "Update", exact: true }).count()) === 0 && !/OpenClaw \d/.test(await text(p, '[data-testid="refusal"]')));
    await click(p, '[data-testid="refusal"] [data-s="refusal-retry"]', 800);
    check(`F-518 ${name}: Try again is a new handshake; still refused`, (await text(p, '[data-testid="refusal"]')).includes(`Tried again at 5:42 PM: protocol ${theirs} again.`) && (await announced(p)) === "Still can't use Home gateway");
    await click(p, '[data-testid="refusal"] [data-s="refusal-gateways"]', 200);
    const g = await text(p, settings);
    check(`F-518 ${name}: Your gateways and Add gateway reachable`, g.includes("Your gateways") && g.includes("Add gateway…") && g.includes("gateway.local · Can't use it"));
    await press(p, "button", "Home gateway gateway.local · Can't use it");
    const pane = await text(p, settings);
    check(`F-518 ${name}: the Gateway pane, Remove reachable, a version only as last seen`, pane.includes("Can't use it") && pane.includes("Remove this gateway…") && pane.includes("Last seen") && pane.includes(lead));
    check(`F-518 ${name}: no page errors`, p.errors.length === 0, p.errors.join(" | "));
    await p.close();
  }
}
{
  const p = await open("required=client&retryok=1");
  await click(p, '[data-testid="refusal"] [data-s="refusal-retry"]', 800);
  check("F-518: a handshake that succeeds ends the refusal", (await rail(p)).includes("Otto") && (await p.locator('[data-testid="refusal"]').count()) === 0 && (await announced(p)) === "Connected to Home gateway");
  await p.close();
}
{
  const p = await open("required=client&feed=1");
  check("F-518: a source alone offers no Update", (await p.getByRole("button", { name: "Update", exact: true }).count()) === 0);
  await p.close();
}
{
  const p = await open("required=client&feed=1&install=1");
  check("F-518: Update only when the updater offers an installable replacement", (await p.getByRole("button", { name: "Update", exact: true }).count()) === 1 && !(await text(p, '[data-testid="refusal"]')).includes("This copy can't update itself"));
  await press(p, "button", "Update");
  await press(p, "button", "Check for Updates", 1100);
  await p.keyboard.press("Escape");
  await p.waitForTimeout(100);
  check("F-518: the refusal stays through a check for updates", (await p.locator('[data-testid="refusal"]').count()) === 1 && (await footer(p)).includes("Can't use it"));
  await p.close();
}
{
  const p = await open("required=client&feed=1&install=1&build=dev");
  check("F-518: a development build offers no Update", (await p.getByRole("button", { name: "Update", exact: true }).count()) === 0);
  await p.close();
}
{
  const p = await open("required=client", { width: 390, height: 844 });
  const t = await text(p, '[data-testid="refusal"]');
  check("F-518, iPhone: where to look, not that a newer build exists", t.includes("Look for a newer Clawtrate in the App Store, or in TestFlight if you test it there.") && !t.includes("This copy can't update itself"));
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
  check("walk: Compact: nothing announced before the reply", !(await announced(p)).startsWith("The gateway reported"));
  await p.waitForTimeout(1400);
  const line = await text(p, '[data-testid="compacted"]');
  check("walk: Compact: a marker matched to the send folds, with the sizes it carries", line.includes("The gateway reported a compaction · 9.7k → 2.1k tokens") && line.includes("3 earlier turns") && (await announced(p)) === "The gateway reported a compaction", line);
  const toggle = p.locator(".s-compacted-toggle");
  check("walk: Compact: the earlier turns folded, a button with aria-expanded", (await toggle.getAttribute("aria-expanded")) === "false" && (await p.locator("#s-fold-j1").isHidden()) && before === 6);
  await toggle.click();
  await p.waitForTimeout(80);
  check("walk: Compact: the fold opens", (await toggle.getAttribute("aria-expanded")) === "true" && (await p.locator("#s-fold-j1").isVisible()) && (await text(p, "#s-fold-j1")).includes("These are earlier turns in this transcript. The gateway reported a compaction here.") && !/summary of these|most recent messages/.test(await text(p, "#s-fold-j1")));
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
  const p = await compactReply("the gateway failed it", "failed", ["The gateway reported that compaction failed.", "Show the gateway's reply"]);
  check("Compact, failed: announced, no claim the context is unchanged", (await announced(p)) === "The gateway reported that compaction failed" && !(await text(p, "#transcript")).includes("as it was"));
  await press(p, "button", "Show the gateway's reply");
  check("Compact, failed: the reply opens as text", (await p.locator("#s-reply").isVisible()) && (await text(p, "#s-reply")).includes("Compaction failed"));
  await p.close();
}
await (await compactReply("nothing to compact", "skipped", ["Nothing to compact yet."])).close();
await (await compactReply("a run was stopped", "stopped", ["The gateway reported that compaction failed.", "The gateway stopped the run that was going. Send that message again."])).close();
{
  const p = await compactReply("a marker without sizes", "nosizes", ["The gateway reported a compaction.", "3 earlier turns"]);
  check("Compact, a marker without sizes: no sizes drawn", !/→|tokens/.test(await text(p, '[data-testid="compacted"]')));
  await p.close();
}
{
  const p = await compactReply("no outcome matched to the send", "unconfirmed", ["Clawtrate hasn't confirmed compaction.", "Refresh history"]);
  check("Compact, no matching outcome: no fold", (await p.locator('[data-testid="compacted"]').count()) === 0);
  await press(p, "button", "Refresh history", 200);
  check("walk: Compact, Refresh history: the marker read, then the fold", (await p.locator('[data-testid="compacted"]').count()) === 1);
  await p.close();
}
{
  const p = await open("bot=juniper&task=j1&compact=running");
  await p.fill(".composer-input", "/compact");
  await p.press(".composer-input", "Enter");
  await p.waitForTimeout(150);
  check("Compact typed while a run is active: the same rule as the button", (await text(p, '[data-testid="compose-note"]')).includes("Compact is available when this run ends.") && !(await text(p, "#transcript")).includes("Compacting"));
  await p.close();
}
{
  const p = await open("bot=juniper&task=j1");
  await p.fill(".composer-input", "/compact");
  await p.press(".composer-input", "Enter");
  await p.waitForTimeout(1500);
  check("Compact typed: drawn as the button's, no /compact bubble", (await p.locator('[data-testid="compacted"]').count()) === 1 && !(await text(p, "#transcript")).includes("/compact"));
  await p.close();
}
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
