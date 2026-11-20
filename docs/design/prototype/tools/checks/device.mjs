// Checks for device.html: every walk of docs/design/device-node.md clicked
// through to its outcome, each state's words, what each access tier is and is
// not offered, the dialogs' focus and Escape, and every state at the desktop
// and phone widths in both themes.
// Run from the repository root:  node docs/design/prototype/tools/checks/device.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("device.html") + "?chrome=0";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query, { width = 1440, height = 900, theme = "light" } = {}) => {
  const p = await b.newPage({ viewport: { width, height } });
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${base}&theme=${theme}&${query}`);
  await p.waitForTimeout(80);
  p.errors = errors;
  return p;
};
const text = (p) => p.evaluate(() => document.querySelector("#root").textContent.replace(/\s+/g, " "));
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const screenOf = (p) => p.evaluate(() => new URLSearchParams(location.search).get("screen"));
const param = (p, key) => p.evaluate((k) => new URLSearchParams(location.search).get(k), key);
const at = async (p, screen) => {
  try {
    await p.waitForFunction((s) => new URLSearchParams(location.search).get("screen") === s, screen, { timeout: 4000 });
    await p.waitForTimeout(60);
    return true;
  } catch {
    return false;
  }
};
const link = (name) => (p) => p.getByRole("link", { name, exact: true }).first().click();
const sw = (p) => p.locator(".b-switch[data-go]").first().click();

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

async function walk(name, start, steps, { width = 1440 } = {}) {
  const p = await open(start, { width, height: width < 500 ? 844 : 900 });
  let ok = true;
  let where = "";
  for (const [action, expect, words = []] of steps) {
    await action(p);
    if (expect && !(await at(p, expect))) {
      ok = false;
      where = `${await screenOf(p)} (expected ${expect})`;
      break;
    }
    const lack = missing(await text(p), words);
    if (lack) {
      ok = false;
      where = `${expect}: missing ${lack}`;
      break;
    }
  }
  check(`walk: ${name}`, ok && p.errors.length === 0, ok ? "" : `stopped at ${where} ${p.errors.join(" | ")}`);
  await p.close();
}

// Part 1: turning it on ------------------------------------------------------------------------

await walk("turning on below admin: the host's dialog, the command for the gateway's computer, device access, on", "screen=mac-off&access=write", [
  [sw, "mac-confirm", ["Let bots on devbox use this Mac?", "asks you before each one is used", "The gateway's owner approves this device first."]],
  [(p) => p.locator("[data-host-confirm]").click(), "mac-waiting-device", ["Approving a device for bots needs admin access.", "openclaw devices approve 3c9b20e4-6f1d-4a7e-9b21-58d0c4e7a6f3", "Cancel request"]],
  [link("The owner approves on devbox"), "mac-waiting-surface", ["Approving this Mac's commands needs device access.", "Request device access", "openclaw nodes approve"]],
  [link("The owner approves on devbox"), "mac-on", ["Connected. Bots can send requests to this Mac."]],
]);
await walk("turning on with admin: Approve this Mac, then its own commands, then on", "screen=mac-off", [
  [sw, "mac-confirm"],
  [(p) => p.locator("[data-host-confirm]").click(), "mac-waiting-device", ["You're connected with admin access, so you can approve this Mac yourself."]],
  [link("Approve this Mac"), "mac-waiting-surface", ["Clawtrate checked that the request lists only Location, Contacts, Calendar and Reminders."]],
  [link("The gateway accepts the approval"), "mac-on"],
]);
await walk("turning on with device access: it approves its own commands", "screen=mac-waiting-surface&access=pairing", [
  [link("The gateway accepts the approval"), "mac-on"],
]);
await walk("on the gateway's own computer: approved by the gateway itself, and said so", "screen=mac-off&via=silent", [
  [sw, "mac-confirm"],
  [(p) => p.locator("[data-host-confirm]").click(), "mac-on", ["The gateway approved this Mac by itself, because Clawtrate runs on the gateway's own computer."]],
]);
await walk("the host's Cancel leaves it off", "screen=mac-off", [
  [sw, "mac-confirm"],
  [(p) => p.locator("[data-host-cancel]").click(), "mac-off"],
]);
await walk("Cancel request turns it off and says so", "screen=mac-waiting-device&access=write", [
  [link("Cancel request"), "mac-off", ["The request was cancelled. Nothing is offered to bots."]],
]);

let p = await open("screen=mac-waiting-device&access=write");
check("waiting below admin: no Approve this Mac", (await p.getByRole("link", { name: "Approve this Mac" }).count()) === 0);
check("waiting: says the gateway would combine a request for more access", (await text(p)).includes("the gateway would combine the two"));
await p.close();
p = await open("screen=mac-confirm");
check("the host's dialog takes focus on its title", await p.evaluate(() => document.activeElement?.id === "s-host-title"));
check("everything behind the host's dialog is inert", await p.evaluate(() => document.querySelector(".b-settings").closest("[inert]") !== null || document.querySelector(".b-settings").inert));
await p.keyboard.press("Escape");
check("Escape on the host's dialog is its Cancel", await at(p, "mac-off"));
await p.close();

// Part 2: what this Mac offers -----------------------------------------------------------------

p = await open("screen=mac-on");
let t = await text(p);
check("on: the seven Mac apps in order", (await p.locator(".d-app .d-app-name").allTextContents()).join(",") === "Location,Contacts,Calendar,Reminders,Messages,Mail,Notes");
check("on: every app says both what this Mac and what the gateway holds", (await p.locator(".d-app").count()) === 7 && (await p.locator(".d-app").evaluateAll((rows) => rows.every((r) => r.textContent.includes("On this Mac:") && r.textContent.includes("On the gateway:")))));
check("on: an app the gateway offers carries the gateway's mark; one it doesn't, none", await p.evaluate(() => {
  const row = (n) => document.querySelector(`[data-app="${n}"]`);
  return row("location").textContent.includes("The gateway enforces this") && !row("messages").textContent.includes("The gateway enforces this");
}));
check("on: what this device holds carries this device's mark", (await p.locator(".d-app").evaluateAll((rows) => rows.every((r) => r.textContent.includes("This device enforces this")))));
check("on: Messages, Mail and Notes read Not offered by the gateway", (await p.locator(".d-app").evaluateAll((rows) => rows.slice(4).every((r) => r.textContent.includes("Not offered: the gateway's allowlist doesn't include it")))));
check("on: an app turned off by the system offers Open Settings and no Allow", await p.evaluate(() => {
  const r = document.querySelector('[data-app="contacts"]');
  return r.textContent.includes("Turned off in System Settings") && r.textContent.includes("Open Settings") && ![...r.querySelectorAll("a")].some((a) => a.textContent === "Allow");
}));
check("on: what this Mac never offers is said", t.includes("Clawtrate never lets a bot run programs, read or list files, use a browser or record the screen on this Mac."));
check("on: which bots can use it, with the listing's date", t.includes("the gateway offered Otto the tool for other devices") && t.includes("Nov 19"));
check("on: what bots are told lists every code", !missing(t, ["NOT_ALLOWED_ON_DEVICE", "NO_ANSWER_ON_DEVICE", "TURNED_OFF_IN_SETTINGS", "TURNED_OFF_ON_DEVICE", "NOT_OPEN_ON_DEVICE", "NOT_FROM_YOUR_CHAT", "NOT_SERVED", "UNAVAILABLE_ON_DEVICE"]));
await p.close();
await walk("allowing Calendar here, with no card", "screen=mac-on", [
  [(p) => p.locator('[data-allow="calendar"]').click(), "mac-on"],
  [async (p) => check("Calendar allowed: the row reads Allowed and it is announced", (await p.locator('[data-app="calendar"]').textContent()).includes("Allowed") && (await p.waitForFunction(() => document.getElementById("device-live").textContent === "Calendar allowed").then(() => true, () => false))), null],
]);
await walk("offline and removed: said from the gateway's read-back", "screen=mac-offline", [
  [async () => {}, null, ["Not connected. Bots that ask this Mac are told it isn't connected.", "Last seen 5:02 PM"]],
  [link("Connect again"), "mac-on"],
]);
p = await open("screen=mac-removed");
check("removed: the owner removed it, the switch is off", (await text(p)).includes("The gateway's owner removed this Mac as a device for bots.") && (await p.locator(".b-switch").getAttribute("aria-checked")) === "false");
await p.close();

// Part 3: the owner's choice -------------------------------------------------------------------

await walk("Messages with admin: the words before the choice, the steps, read back, allowed", "screen=mac-on", [
  [(p) => p.locator('[data-allowx="messages"]').click(), "mac-messages-confirm", ["Let bots use Messages on this Mac?", "Otto could do", "reading your conversations and sending messages as you", "The gateway's allowlist is for every bot."]],
  [link("Allow Messages"), "mac-messages-steps", ["Adding Messages to the gateway's allowlist", "Asking the gateway to accept it", "Reading back"]],
  [link("The gateway reads back the command"), "mac-messages-on"],
  [async (p) => check("Messages allowed: offered by the gateway, allowed on this Mac", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]').textContent;
    return r.includes("Offered to bots") && r.includes("Allowed");
  })), null],
]);
await walk("Mail and Notes have their own words", "screen=mac-on", [
  [(p) => p.locator('[data-allowx="mail"]').click(), "mac-messages-confirm", ["Let bots use Mail on this Mac?", "reading your mail and sending mail as you"]],
  [link("Cancel"), "mac-on"],
  [(p) => p.locator('[data-allowx="notes"]').click(), "mac-messages-confirm", ["Let bots use Notes on this Mac?", "reading and changing your notes"]],
]);
p = await open("screen=mac-messages-confirm");
check("the choice's dialog takes focus and makes the page behind inert", await p.evaluate(() => document.activeElement?.id === "d-dialog-title" && document.querySelector(".b-settings").inert));
check("the choice never calls anything safe", !/\b(safe|secure|private|protected)\b/i.test(await text(p)));
await p.keyboard.press("Escape");
check("Escape on the choice is its Cancel", await at(p, "mac-on"));
await p.close();
await walk("the allowlist written but not accepted: what the gateway holds, and the ways on", "screen=mac-messages-steps&fail=2", [
  [async () => {}, null, ["Messages is on the gateway's allowlist, but the gateway hasn't accepted it from this Mac yet.", "Try again", "Remove it from the allowlist"]],
  [link("Try again"), "mac-messages-steps"],
  [async (p) => check("Try again leaves the failure behind", (await param(p, "fail")) === null), null],
]);
await walk("Messages below admin: the owner is needed, and admin can be requested", "screen=mac-on&access=write", [
  [(p) => p.locator('[data-allowx="messages"]').click(), "mac-messages-needadmin", ["Messages needs the gateway's owner.", "Adding it to the gateway's allowlist needs admin access.", "Request admin access"]],
]);
await walk("Messages turned off on this Mac", "screen=mac-messages-on&own=offered", [
  [(p) => p.locator('[data-turnoff="messages"]').click(), "mac-on"],
  [async (p) => check("turned off: Messages reads Denied, still offered", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]').textContent;
    return r.includes("Denied") && r.includes("Offered to bots");
  })), null],
]);
await walk("Messages removed from the allowlist: the words, then not offered", "screen=mac-messages-on&own=offered", [
  [(p) => p.locator('[data-remove="messages"]').click(), "mac-messages-remove", ["A request waiting for this Mac ends at once", "What this Mac already did is not undone."]],
  [link("Remove"), "mac-on"],
  [async (p) => check("removed: Messages reads Not offered", (await p.locator('[data-app="messages"]').textContent()).includes("Not offered")), null],
]);
p = await open("screen=mac-messages-on&own=offered&access=write");
check("below admin: no Remove from the allowlist", (await p.locator("[data-remove]").count()) === 0);
await p.close();

// Part 4: stopping -----------------------------------------------------------------------------

await walk("stopping, kept on the gateway", "screen=mac-on", [
  [sw, "mac-stop", ["Stop letting bots use this Mac?", "The gateway keeps this Mac as a device until its owner removes it."]],
  [link("Stop"), "mac-off", ["The gateway keeps it as a device until its owner removes it."]],
]);
await walk("stopping, and removing it from the gateway with admin", "screen=mac-stop", [
  [(p) => p.locator("[data-also-remove]").check(), null],
  [link("Stop"), "mac-off", ["the gateway no longer lists it as a device"]],
]);
p = await open("screen=mac-stop&access=write");
check("stopping below admin: no Also remove it from the gateway", (await p.locator("[data-also-remove]").count()) === 0);
await p.close();

// Part 5: other devices ------------------------------------------------------------------------

await walk("another device with admin: approve after the confirmation", "screen=machines", [
  [async () => {}, null, ["Devices asking to be used by bots", "Kitchen iPad asks to be a device bots can use", "It also offers commands that run programs or read files on it"]],
  [(p) => p.locator('[data-request="ipad"]').getByRole("link", { name: "Approve" }).click(), "machines", ["Approve Kitchen iPad for bots?", "What the device does with a request is up to the device."]],
  [(p) => p.locator(".d-dialog").getByRole("link", { name: "Approve" }).click(), "machines", ["Kitchen iPad was approved as a device for bots (read back 5:22 PM)."]],
]);
await walk("another device's admin-tier commands are named before approving", "screen=machines", [
  [(p) => p.locator('[data-request="pc"]').getByRole("link", { name: "Approve" }).click(), "machines", ["and to run programs and read files on it", "system.run", "fs.listDir"]],
]);
await walk("another device rejected", "screen=machines", [
  [(p) => p.locator('[data-request="ipad"]').getByRole("link", { name: "Reject" }).click(), "machines", ["Kitchen iPad's request was rejected"]],
]);
p = await open("screen=machines&access=pairing");
check("below admin, even with device access: one line, never a list", (await text(p)).includes("Approving other devices for bots needs admin access.") && (await p.locator(".d-request").count()) === 0);
await p.close();

// Part 6: the permission card ------------------------------------------------------------------

const phone = { width: 390 };
await walk("the card: Allow while the call is open answers it", "screen=card-pending", [
  [async () => {}, null, ["Otto wants your location on this iPhone", "Needs permission", "Allowing lets any bot that can use this iPhone get it from now on.", "Otto's request waits until 5:44:30 PM."]],
  [(p) => p.locator("[data-ask-allow]").click(), "card-sent", ["Allowed. This iPhone sent Otto's request its answer at 5:44 PM."]],
], phone);
await walk("the card: an Allow the gateway no longer waited for reached no one", "screen=card-pending", [
  [link("Allow after the gateway stopped waiting"), "card-ignored", ["The request had ended when this iPhone answered, so nothing reached Otto."]],
], phone);
await walk("the card: Don't allow tells the bot", "screen=card-pending", [
  [(p) => p.locator("[data-ask-deny]").click(), "card-dontallow", ["Otto was told you chose Don't allow."]],
], phone);
await walk("the card: the call ends, then Allow for next time runs nothing", "screen=card-pending", [
  [link("30 seconds pass"), "card-ended", ["Otto's request ended at 5:44 PM and nothing was sent.", "five minutes after the request"]],
  [(p) => p.locator("[data-ask-allow]").click(), "card-later", ["Otto's request ended at 5:44 PM and wasn't run.", "Otto will be answered the next time it asks."]],
], phone);
await walk("the card: five minutes with no answer reads Timed out", "screen=card-ended", [
  [link("Five minutes pass"), "card-timedout", ["Timed out. Nothing was sent, and Location is still not allowed."]],
], phone);
await walk("the card: Don't allow after the call ended", "screen=card-ended", [
  [(p) => p.locator("[data-ask-deny]").click(), "card-dontallow", ["Otto's request had ended."]],
], phone);
p = await open("screen=card-settings", { width: 390, height: 844 });
check("turned off in Settings: Open Settings, no Allow", (await text(p)).includes("Open Settings") && (await p.locator("[data-ask-allow]").count()) === 0);
await p.close();
p = await open("screen=card-pending", { width: 390, height: 844 });
check("the card is a region named for its request, and does not take focus", await p.evaluate(() => {
  const c = document.querySelector(".d-ask");
  return c.getAttribute("role") === "region" && c.getAttribute("aria-label").includes("Needs permission") && !c.contains(document.activeElement);
}));
check("the card never says Resumed", !(await text(p)).includes("Resumed"));
check("the iPhone's screens are at phone width with touch sizes", await p.evaluate(() => document.documentElement.dataset.width === "phone" && document.documentElement.dataset.input === "touch"));
await p.close();
p = await open("screen=mac-request");
check("a request that named no task: in Requests for this device, with the banner", !missing(await text(p), ["A request for Calendar on this Mac", "Requests for this device", "It didn't say which task it came from."]));
await p.locator("[data-ask-allow]").click();
check("that request allowed: said in place", (await at(p, "mac-request")) && (await text(p)).includes("Calendar is allowed for bots from now on."));
await p.close();

// Part 7: the iPhone ---------------------------------------------------------------------------

p = await open("screen=phone-on", { width: 390, height: 844 });
check("This iPhone: its six apps in order", (await p.locator(".d-app .d-app-name").allTextContents()).join(",") === "Calendar,Contacts,Location,Reminders,Alarms,Home");
check("This iPhone: Allow, Allowed and Denied are its values", !missing(await text(p), ["Allowed", "Denied", "Allow", "Turned off in Settings", "Connected while Clawtrate is open."]));
await p.close();
p = await open("screen=phone-back", { width: 390, height: 844 });
check("back from the background: what was refused, and what never arrived", !missing(await text(p), ["While Clawtrate was in the background, Otto asked this iPhone for your location at 5:41 PM. Otto was told Clawtrate wasn't open.", "never reached it"]));
await p.close();

await walk("share: To, the items, the note, Send, then sent", "screen=share", [
  [async () => {}, null, ["To:", "Juniper", "https://trail-guide.example/saturday", "trail-map.png", "Send starts a new task with Juniper. Nothing is sent before."]],
  [(p) => p.locator("[data-share-send]").click(), "share-sent", ["Sent to Juniper"]],
], phone);
await walk("share: another bot chosen, then sent to it", "screen=share", [
  [(p) => p.locator("[data-to-row]").click(), "share-to"],
  [(p) => p.locator('[data-to="otto"]').click(), "share", ["Send starts a new task with Otto."]],
  [(p) => p.locator("[data-share-send]").click(), "share-sent", ["Sent to Otto"]],
], phone);
await walk("share: when it can't finish, Open in Clawtrate puts it in the composer, unsent", "screen=share&link=down", [
  [(p) => p.locator("[data-share-send]").click(), "share-cant", ["Clawtrate can't reach the gateway from here.", "Nothing was sent."]],
  [link("Open in Clawtrate"), "share-draft", ["Shared from another app. Nothing has been sent.", "trail-map.png"]],
], phone);
p = await open("screen=share", { width: 390, height: 844 });
check("share: a link is text, never fetched or linked", (await p.locator('.d-chips a[href^="http"]').count()) === 0);
await p.close();

await walk("Send Message: asks first, then sent", "screen=siri-confirm", [
  [async () => {}, null, ["Send to Juniper?", "Remind me to water the plants tonight.", "Clawtrate always asks before it sends."]],
  [(p) => p.locator("[data-siri-send]").click(), "siri-sent", ["Sent to Juniper."]],
], phone);
await walk("Send Message: when it can't, Open in Clawtrate puts it in the composer", "screen=siri-confirm&link=down", [
  [(p) => p.locator("[data-siri-send]").click(), "siri-fail", ["Clawtrate couldn't send this"]],
  [link("Open in Clawtrate"), "share-draft", ["From Send Message. Nothing has been sent."]],
], phone);
p = await open("screen=siri-list", { width: 390, height: 844 });
check("List Bots: the names, the primary bot first", (await text(p)).includes("You have four bots: Juniper, Marlow, Otto and Pip."));
await p.close();
p = await open("screen=siri-list-fail", { width: 390, height: 844 });
check("List Bots, unreachable: no list from memory", (await text(p)).includes("Clawtrate couldn't reach the gateway.") && (await p.locator(".d-sys li").count()) === 0);
await p.close();

// Part 8: every state, both widths, both themes ------------------------------------------------

p = await open("screen=mac-off");
const screens = await p.evaluate(() => window.CT.deviceScreens);
await p.close();
check("the page lists its states", screens.length >= 30, String(screens.length));
const banned = /\b(safe|secure|securely|private|protected)\b/i;
for (const [label, width] of [["desktop", 1100], ["phone", 390]]) {
  let bad = [];
  let words = [];
  let errors = [];
  for (const screen of screens) {
    for (const theme of ["light", "dark"]) {
      const q = await open(`screen=${screen}${label === "phone" ? "&width=phone" : "&width=full"}`, { width, height: 844, theme });
      if (!(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) bad.push(`${screen}/${theme}`);
      if (theme === "light" && banned.test(await text(q))) words.push(screen);
      if (q.errors.length) errors.push(`${screen}: ${q.errors[0]}`);
      if (theme === "dark" && !(await q.evaluate(() => document.documentElement.dataset.theme === "dark"))) errors.push(`${screen}: not dark`);
      await q.close();
    }
  }
  check(`every state at ${label} width, light and dark: no sideways scroll`, bad.length === 0, bad.join(" "));
  check(`every state at ${label} width: no page errors`, errors.length === 0, errors.join(" | "));
  check(`every state at ${label} width: never says safe, secure, private or protected`, words.length === 0, words.join(" "));
}
p = await open("screen=card-pending&width=phone", { width: 390, height: 844 });
check("phone: the card's buttons are touch-sized", await p.evaluate(() => [...document.querySelectorAll(".d-ask .d-actions .button")].every((el) => el.getBoundingClientRect().height >= 44)));
await p.close();
p = await open("screen=phone-on&width=phone", { width: 390, height: 844 });
check("phone: app rows are 72 px or taller", await p.evaluate(() => [...document.querySelectorAll(".d-app")].every((el) => el.getBoundingClientRect().height >= 72)));
await p.close();

// Part 9: the gallery, the index and the bar reach this page -----------------------------------

p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(100);
check("gallery: links to the device page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "device.html")));
check("the prototype bar links to the device page", await p.evaluate(() => [...document.querySelectorAll("#proto-bar a")].some((a) => a.getAttribute("href") === "device.html")));
await p.goto(pageUrl("index.html"));
check("index: links to the device page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href") === "device.html")));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
