// Checks for device.html: every walk of docs/design/device-node.md clicked
// through to its outcome, each state's words, what each access tier is and is
// not offered, the dialogs' focus, trap and Escape, and every state at desktop
// and phone width in both themes. Each group of lines fails without the rule
// it is named for.
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
const phone = { width: 390, height: 844 };
const text = (p, sel = "#root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
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
const click = (selector) => (p) => p.locator(selector).first().click();
const button = (name) => (p) => p.getByRole("button", { name, exact: true }).first().click();
const link = (name) => (p) => p.getByRole("link", { name, exact: true }).first().click();
const sw = (p) => p.locator(".b-switch[data-go]").first().click();
const row = (p, id) => p.locator(`[data-app="${id}"]`).first();

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

async function walk(name, start, steps, opts = {}) {
  const p = await open(start, opts);
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
      where = `${expect || "here"}: missing ${lack}`;
      break;
    }
  }
  check(`walk: ${name}`, ok && p.errors.length === 0, ok ? "" : `stopped at ${where} ${p.errors.join(" | ")}`);
  await p.close();
}
const none = async () => {};

// 1. A chat's kind is not consent: no screen says whose chat or who asked --------------------

for (const [task, words] of [
  ["listed", ["The request names a task of Otto's, “Plan Saturday”.", "can't confirm who sent it"]],
  ["other", ["The request names a task this iPhone doesn't list", "can't confirm who sent it"]],
  ["none", ["The request names no task.", "can't confirm who sent it"]],
]) {
  const p = await open(`screen=card-pending&task=${task}`, phone);
  check(`card, task ${task}: says what the request named, and that this iPhone can't confirm who sent it`, !missing(await text(p, ".d-ask"), words), missing(await text(p, ".d-ask"), words));
  check(`card, task ${task}: the title names the app, not an asker`, (await text(p, ".d-ask .request-title")) === "Location requested on this iPhone");
  await p.close();
}
let p = await open("screen=card-pending&task=other", phone);
check("card for a task this iPhone doesn't list: on This iPhone, in Requests to this device", (await text(p)).includes("Requests to this device") && (await p.locator(".d-chat").count()) === 0);
await p.close();

// 2. The node's own credential, and admin for it ---------------------------------------------

p = await open("screen=mac-off&access=write");
check("below admin: the switch is unavailable", (await p.locator(".b-switch").getAttribute("aria-disabled")) === "true" && (await p.locator(".b-switch[data-go]").count()) === 0);
check("below admin: it says only an admin connection can get the device sign-in, with Request admin access", (await text(p)).includes("only an admin connection can get this Mac's device sign-in") && (await p.getByRole("button", { name: "Request admin access" }).count()) === 1);
await p.close();
p = await open("screen=phone-off&access=read", phone);
check("below admin on the iPhone: the switch is unavailable too", (await p.locator(".b-switch").getAttribute("aria-disabled")) === "true");
await p.close();
const stepStates = (p) => p.evaluate(() => [...document.querySelectorAll(".s-steps li")].map((li) => li.dataset.state).join(","));
const switchOff = (p) => p.evaluate(() => document.querySelector(".b-switch").getAttribute("aria-checked") === "false");
for (const [dev, start, steps, onWords] of [
  ["Mac", "mac-off", "mac-steps", ["This host's node socket has a hello.", "The gateway listed Studio Mac (bots) as connected at 5:31 PM."]],
  ["iPhone", "phone-off", "phone-steps", []],
]) {
  await walk(`turning on the ${dev} with admin: the dialog, each done mark after its own read, on`, `screen=${start}`, [
    [sw, start.replace("off", "confirm"), [`Let bots on devbox use this ${dev}?`, `Clawtrate will ask the connected gateway for a one-time sign-in for this ${dev} as a device for bots. The next screen shows what the gateway listed.`]],
    [click("[data-host-confirm]"), steps],
    [async (p) => check(`${dev}, connecting: the switch is not checked, and only the first read is running`, (await switchOff(p)) && (await stepStates(p)) === "running,waiting,waiting"), null],
    [link("The gateway answers with a node code"), steps, ["The gateway answered with a usable code for the node role only, for this gateway's address."]],
    [async (p) => check(`${dev}: after the code's read, step 1 done and step 2 running`, (await switchOff(p)) && (await stepStates(p)) === "done,running,waiting"), null],
    [link("The node's hello arrives"), steps, ["Its hello says role node."]],
    [async (p) => check(`${dev}: after the hello, step 2 done and step 3 running`, (await switchOff(p)) && (await stepStates(p)) === "done,done,running"), null],
    [link("The read-back agrees"), start.replace("off", "on"), onWords],
    [async (p) => check(`${dev}, first-time activation: no app reads Allowed before the person's own Allow`, (await p.locator("[data-local=allowed]").count()) === 0 && (await p.locator("[data-local=undecided]").count()) >= 3), null],
    [click("[data-allow]:not([data-allow=contacts])"), start.replace("off", "on")],
    [async (p) => check(`${dev}, first-time activation: one Allow makes exactly that app Allowed`, (await p.locator("[data-local=allowed]").count()) === 1), null],
  ], dev === "iPhone" ? phone : {});
}
p = await open("screen=mac-confirm");
check("the host's dialog makes no promise about the gateway's pairing before its read", !(await text(p)).includes("pairs it without asking anyone else"));
await p.close();
p = await open("screen=mac-steps&fail=code");
check("a missing-admin answer: only it says admin is needed; the switch stays off", (await text(p)).includes("The gateway didn't give this Mac a device sign-in: it needs admin access.") && (await switchOff(p)));
await p.close();
p = await open("screen=mac-steps&fail=codeother");
check("any other code failure: couldn't get the sign-in, with the gateway's reason as text, and no admin claim", !missing(await text(p), ["Couldn't get this Mac's device sign-in.", "pairing setup needs a gateway address it can reach"]) && !(await text(p)).includes("needs admin access") && (await switchOff(p)) && (await p.locator("[data-retry]").count()) === 1);
await p.close();
p = await open("screen=mac-steps&fail=hello");
check("a lost hello: the attempt is closed, pairing unconfirmed, Try again", (await text(p)).includes("This Mac stopped trying to connect. The gateway pairing couldn't be confirmed.") && (await p.locator("[data-retry]").count()) === 1 && (await stepStates(p)) === "done,failed,waiting");
await p.close();
p = await open("screen=mac-steps&fail=read");
check("an unavailable first read: couldn't read, Check again, not on", (await text(p)).includes("Couldn't read what the gateway lists.") && (await p.getByRole("button", { name: "Check again" }).count()) === 1 && (await stepStates(p)) === "done,done,failed");
await p.close();
p = await open("screen=mac-steps&fail=pending");
check("a pending command request shows only the pending commands", await p.evaluate(() => {
  const n = document.querySelector(".b-note").textContent;
  return n.includes("calendar.events") && n.includes("reminders.list") && !n.includes("location.get") && !n.includes("contacts.search");
}));
await p.close();
await walk("a strict subset: the omission named, then finished with that subset", "screen=mac-steps&at=2", [
  [link("It lists a strict subset"), "mac-steps", ["The gateway listed some of this Mac's commands.", "Not listed: reminders.list."]],
  [click("[data-finish]"), "mac-on"],
  [async (p) => check("after a subset: Reminders reads Not listed, the others Listed", (await row(p, "reminders").getAttribute("data-gateway")) === "notlisted" && (await row(p, "calendar").getAttribute("data-gateway")) === "listed"), null],
]);
p = await open("screen=mac-confirm");
check("the host's dialog never says the gateway's owner approves", !/owner approves/.test(await text(p)));
check("the host's dialog says Allow is ongoing before any app is used", (await text(p, "[role=alertdialog]")).includes("Clawtrate asks you before an app's first use. Later requests that reach this device may use an app you allowed without asking again."));
await p.close();
await walk("the iPhone on, then Stop", "screen=phone-on", [
  [sw, "phone-stop", ["Stop letting bots use this iPhone?"]],
  [click("[data-stop]"), "phone-stopped", ["Stopped on this iPhone."]],
], phone);
await walk("a code that doesn't pair: the gateway's reason, and Try again", "screen=mac-steps&fail=pair", [
  [none, null, ["The gateway didn't pair this Mac with the code.", "PAIRING_REQUIRED"]],
  [click("[data-retry]"), "mac-steps"],
  [async (p) => check("Try again starts over with no failure", (await param(p, "fail")) === null), null],
]);
p = await open("screen=mac-steps&fail=extra");
check("a read-back listing a command this Mac didn't declare: disconnected, named", !missing(await text(p), ["The gateway lists commands this Mac doesn't offer. Clawtrate disconnected it.", "system.run"]));
check("that failure is not shown as done", (await p.locator('[data-state="failed"]').count()) === 1 && (await p.locator('[data-state="running"]').count()) === 0);
await p.close();
p = await open("screen=mac-steps&fail=code");
check("no code: the first step failed and nothing later ran", (await p.locator('.s-steps li[data-state="failed"]').count()) === 1 && (await p.locator('.s-steps li[data-state="done"]').count()) === 0);
await p.close();
for (const [screen, words] of [
  ["mac-offline", ["Not connected. Clawtrate is trying again.", "The gateway last saw it at 5:02 PM (connect)."]],
  ["mac-refused", ["The gateway refused this Mac's device sign-in. Turn it on again to get a new one."]],
  ["mac-unlisted", ["The gateway no longer lists this Mac as a device for bots."]],
]) {
  p = await open(`screen=${screen}`);
  check(`${screen}: says what was read`, !missing(await text(p), words), missing(await text(p), words));
  await p.close();
}

// 3. The gateway's listing never becomes this device's permission ---------------------------

p = await open("screen=mac-on");
check("on: the seven Mac apps in order", (await p.locator(".d-app .d-app-name").allTextContents()).join(",") === "Location,Contacts,Calendar,Reminders,Messages,Mail,Notes");
check("on: no app row names a program, file, browser or screen command", !(await p.locator(".d-apps").evaluate((el) => /system\.|fs\.|browser\.|screen\./.test(el.textContent))));
check("on: every app says what this Mac decided and what the gateway listed", await p.locator(".d-app").evaluateAll((rows) => rows.length === 7 && rows.every((r) => r.textContent.includes("On this Mac:") && r.textContent.includes("Gateway:"))));
check("on: a listed app carries the listing mark with its time, not a refusal", await p.evaluate(() => {
  const r = document.querySelector('[data-app="location"]');
  return !!r.querySelector('[data-mark="listed"]') && r.textContent.includes("Listed by the gateway, 5:31 PM") && !r.querySelector('[data-mark="gateway"]');
}));
check("on: Messages, Mail and Notes read Not listed when read, with no refusal mark, and the allowlist entries read as absent", await p.evaluate(() => ["messages", "mail", "notes"].every((id) => {
  const r = document.querySelector(`[data-app="${id}"]`);
  return r.dataset.gateway === "notlisted" && r.textContent.includes("Gateway: Not listed when read at 5:31 PM") && !r.querySelector('[data-mark="gateway"]') && /didn't include clawtrate\.\w+\.\w+ or clawtrate\.\w+\.\w+ when read at 5:31 PM/.test(r.querySelector("[data-absent]")?.textContent || "");
})));
check("on: no row carries a gateway refusal mark without an observed refusal", (await p.locator('.d-apps [data-mark="gateway"]').count()) === 0);
check("on: an undecided app says what Allow lets through before the tap", (await row(p, "calendar").textContent()).includes("Allow lets every request for Calendar that reaches this Mac read your calendar's events, from now on, until you turn it off."));
check("on: an app the system refuses offers Open Settings and no Allow", await p.evaluate(() => {
  const r = document.querySelector('[data-app="contacts"]');
  return r.textContent.includes("Turned off in System Settings") && !!r.querySelector('[aria-label="Open Settings for Contacts"]') && !r.querySelector("[data-allow]");
}));
check("on: bots offered the tool, each with its listing date, and the bot with no listing", (await text(p, "[data-bots]")).includes("Otto (listed Nov 19). Juniper and Marlow: not offered (listed Nov 18, Nov 19). Pip: no listing yet."));
check("on: no claim that no bot can use other devices while a bot has no listing", !(await text(p)).includes("did not show a bot with the tool") && !(await text(p)).includes("No bot can use"));
check("on: what this Mac never offers is said", (await text(p)).includes("Clawtrate never lets a bot run programs, read or list files, use a browser or record the screen on this Mac."));
check("on: the examples carry this Mac's own name, and are labelled as examples", await p.evaluate(() => {
  const d = document.querySelector(".d-told");
  return d.textContent.includes("Studio Mac") && !d.textContent.includes("iPhone") && d.textContent.includes("Examples. Each request's record shows");
}));
await p.close();
for (const [q, opts] of [["mac-on&history=1", {}], ["phone-on&history=1", phone], ["mac-on&allowed=calendar,messages&own=listed&app=messages", {}]]) {
  p = await open(`screen=${q}`, opts);
  check(`${q}: Allowed and Not decided rows never carry a refusal mark; Denied and OS-blocked rows carry this device's`, await p.evaluate(() => [...document.querySelectorAll(".d-app[data-local]")].every((r) => {
    const refusal = !!r.querySelector('[data-mark="device"], [data-mark="gateway"]');
    return ["allowed", "undecided"].includes(r.dataset.local) ? !refusal : !!r.querySelector('[data-mark="device"]');
  })));
  check(`${q}: an undecided row says it will ask`, await p.evaluate(() => [...document.querySelectorAll('.d-app[data-local="undecided"]')].every((r) => r.textContent.includes("Clawtrate asks you first"))));
  check(`${q}: both values that offer Allow disclose ongoing permission before the tap`, await p.evaluate(() => [...document.querySelectorAll(".d-app")].filter((r) => r.querySelector("[data-allow]")).every((r) => /from now on, until you turn it off/.test(r.querySelector("[data-scope]")?.textContent || ""))));
  await p.close();
}
p = await open("screen=mac-on&history=1");
check("F-347: a denied local grant offers only local Allow to change that choice", await p.evaluate(() => {
  const r = document.querySelector('[data-app="reminders"]');
  return r.dataset.local === "denied" && !!r.querySelector('[data-allow="reminders"]') && !r.textContent.includes("Open Settings") && r.textContent.includes("Allow lets every request for Reminders");
}));
await p.close();
p = await open("screen=mac-on&own=listed&app=messages&half=messages");
check("a half-listed app shows the two command facts", await p.evaluate(() => {
  const r = document.querySelector('[data-app="messages"]');
  return r.dataset.gateway === "partial" && r.textContent.includes("Listed, 5:31 PM: clawtrate.messages.read") && (r.querySelector("[data-missing]")?.textContent || "") === "Not listed when read at 5:31 PM: clawtrate.messages.send" && !r.textContent.includes("Listed, 5:31 PM" + "Listed");
}));
await p.close();
p = await open("screen=phone-on", phone);
check("This iPhone: its six apps in order", (await p.locator(".d-app .d-app-name").allTextContents()).join(",") === "Calendar,Contacts,Location,Reminders,Alarms,Home");
check("This iPhone: the examples carry the iPhone's name, never the Mac's", await p.evaluate(() => {
  const d = document.querySelector(".d-told");
  return d.textContent.includes("iPhone") && !d.textContent.includes("Studio Mac");
}));
await p.close();
await walk("Messages added with admin: the words before writing, the read-backs, and this Mac's decision untouched", "screen=mac-on", [
  [click('[data-add="messages"]'), "mac-messages-confirm"],
  [async (p) => {
    const t = await text(p, "[role=alertdialog]");
    const lack = missing(t, ["Let bots ask this Mac for Messages?", "clawtrate.messages.read", "clawtrate.messages.send", "read the messages of a conversation it names and send a text message as you", "Otto (listed Nov 19)", "Pip has no listing yet", "a bot added later", "any device connected to the gateway with write access", "This doesn't allow Messages on this Mac. This keeps this Mac's current Messages choice. You can change that choice here."]);
    check("the add confirmation itself names each bot with its date, and keeps this Mac's choice", !lack, lack);
  }, null],
  [click("[data-confirm]"), "mac-messages-steps", ["Writing Messages to the gateway's allowlist", "The gateway's stored settings list clawtrate.messages.read and clawtrate.messages.send (read 5:33 PM).", "Clawtrate compared the request with what this Mac declares, then approved it with admin.", "Reading back"]],
  [link("The gateway lists the commands for this Mac"), "mac-messages-on"],
  [async (p) => check("after the add: the stored and the active read-back are reported apart", (await text(p, "[data-stored]")) === "The gateway's stored settings list clawtrate.messages.read and clawtrate.messages.send (read 5:33 PM)." && (await text(p, "[data-active]")) === "The gateway listed them for Studio Mac (bots) at 5:33 PM."), null],
  [async (p) => check("after the gateway step: Messages listed by the gateway, and still Not decided on this Mac", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]');
    return r.dataset.gateway === "listed" && r.dataset.local === "undecided" && !!r.querySelector('[data-allow="messages"]');
  })), null],
  [click('[data-allow="messages"]'), "mac-on"],
  [async (p) => check("then the person's own Allow: Messages Allowed, with Turn off", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]');
    return r.dataset.local === "allowed" && !!r.querySelector('[data-turnoff="messages"]');
  })), null],
]);
await walk("a local denial before the add stays a denial after it", "screen=mac-on&prior=denied&app=messages", [
  [click('[data-add="messages"]'), "mac-messages-confirm"],
  [click("[data-confirm]"), "mac-messages-steps"],
  [link("The gateway lists the commands for this Mac"), "mac-messages-on"],
  [async (p) => check("prior denial kept: listed, and Denied on this Mac", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]');
    return r.dataset.gateway === "listed" && r.dataset.local === "denied";
  })), null],
]);
await walk("Mail and Notes have their own commands and words", "screen=mac-on", [
  [click('[data-add="mail"]'), "mac-messages-confirm", ["Let bots ask this Mac for Mail?", "clawtrate.mail.search", "search your mail and read what it finds, and send a message as you"]],
  [link("Cancel"), "mac-on"],
  [click('[data-add="notes"]'), "mac-messages-confirm", ["Let bots ask this Mac for Notes?", "clawtrate.notes.create"]],
]);
await walk("Alarms added on the iPhone: its own words, on This iPhone", "screen=phone-on", [
  [click('[data-add="alarms"]'), "mac-messages-confirm", ["Let bots ask this iPhone for Alarms?", "clawtrate.alarms.set", "This doesn't allow Alarms on this iPhone."]],
]);
p = await open("screen=mac-messages-steps&fail=1quiet");
check("a write with no answer never says nothing changed", (await text(p)).includes("Clawtrate couldn't confirm whether the gateway's settings changed.") && !(await text(p)).includes("Nothing changed"));
check("an unknown write cannot announce that the command vanished", !/doesn't include|no longer list|Removed|didn't write/.test(await text(p, ".b-note")) && (await param(p, "said")) === null);
await p.close();
p = await open("screen=mac-messages-steps&fail=1");
check("a refused write gives the gateway's reason and the entries actually read", !missing(await text(p), ["The gateway refused this change: config.patch denied.", "The gateway's allowlist, read at 5:33 PM: calendar.add."]) && !(await text(p)).includes("doesn't include Messages") && (await p.locator('[data-mark="gateway"]').count()) === 1);
await p.close();
p = await open("screen=mac-messages-steps&fail=1&reread=fail");
check("a refused write whose re-read fails says it couldn't read the allowlist", (await text(p)).includes("Couldn't read the gateway's allowlist."));
await p.close();
await walk("a hash conflict: nothing written, and Try again reads again before proposing the patch", "screen=mac-messages-steps&fail=hash", [
  [none, null, ["The gateway's settings changed since Clawtrate read them. Clawtrate didn't write this change."]],
  [click("[data-retry]"), "mac-messages-confirm"],
]);
await walk("written but not listed: what the gateway holds, and the ways on", "screen=mac-messages-steps&fail=2", [
  [none, null, ["The gateway's settings list Messages, but the gateway doesn't list it for this Mac yet.", "Try again", "Remove it from the allowlist"]],
  [button("Try again"), "mac-messages-steps"],
  [async (p) => check("Try again leaves the failure behind", (await param(p, "fail")) === null), null],
]);
await walk("Messages below admin: the owner is needed, and admin can be requested", "screen=mac-on&access=write", [
  [click('[data-add="messages"]'), "mac-messages-needadmin", ["Adding it to the gateway's allowlist needs admin access.", "Request admin access"]],
  [async (p) => check("below admin: no \"needs the gateway's owner\" beside the admin line", !(await text(p)).includes("needs the gateway's owner")), null],
]);
p = await open("screen=mac-messages-confirm");
check("the choice's dialog takes focus and makes the page behind inert", await p.evaluate(() => document.activeElement?.id === "d-dialog-title" && document.querySelector(".b-settings").inert));
await p.keyboard.press("Escape");
check("Escape on the choice is its Cancel", await at(p, "mac-on"));
await p.close();

// 4. The card says what this device did and what the gateway acknowledged --------------------

await walk("the card: Allow, sent, the gateway accepted", "screen=card-pending", [
  [none, null, ["Needs permission", "Allow gets your location for this request, and lets every later request for Location that reaches this iPhone get it, until you turn it off.", "Clawtrate closes this card by 5:44:30 PM."]],
  [click("[data-ask-allow]"), "card-sent", ["This iPhone got your location and sent it at 5:44 PM; the gateway accepted the answer."]],
], phone);
await walk("the card: an answer the gateway ignored says the operation ran", "screen=card-pending", [
  [link("Allow, then the gateway ignores the answer"), "card-ignored", ["This iPhone got your location and sent it at 5:44 PM. The gateway ignored this device's answer. This request set Location to Allowed."]],
], phone);
await walk("the card: no acknowledgement says it couldn't confirm", "screen=card-pending", [
  [link("Allow, and no acknowledgement"), "card-unconfirmed", ["Clawtrate couldn't confirm the gateway received it."]],
], phone);
await walk("the card: Don't allow, refusal accepted", "screen=card-pending", [
  [click("[data-ask-deny]"), "card-dontallow", ["This iPhone didn't run the request and sent the refusal NOT_ALLOWED_ON_DEVICE at 5:44 PM; the gateway accepted it. This request set Location to Denied."]],
], phone);
await walk("the card: Don't allow, refusal ignored", "screen=card-pending", [
  [link("Don't allow, and the gateway ignores it"), "card-dontallow", ["sent the refusal NOT_ALLOWED_ON_DEVICE at 5:44 PM. The gateway ignored this device's answer. This request set Location to Denied."]],
], phone);
await walk("the card: turned off on this iPhone while it waited", "screen=card-pending", [
  [link("Turn off Location on this iPhone"), "card-turnedoff", ["Location was turned off on this iPhone while the request waited.", "TURNED_OFF_ON_DEVICE"]],
], phone);
for (const s of ["card-sent", "card-ignored", "card-unconfirmed", "card-dontallow", "card-turnedoff", "card-stopped", "card-timedout", "card-cap"]) {
  p = await open(`screen=${s}`, phone);
  const t = await text(p);
  check(`${s}: never says what a caller received, never "Resumed"`, !/was told|Resumed|reached Otto|Otto got/.test(t));
  check(`${s}: the result line is in absolute words: a clock time, no relative time, no standing claim about the app`, await p.evaluate(() => {
    const w = document.querySelector("[data-words]").textContent;
    return (/\b\d{1,2}:\d{2} PM\b/.test(w) || /turned off on this iPhone|stopped answering/.test(w)) && !/\b(seconds?|minutes?) (ago|left|from now)\b|from now on|stays Denied|still not decided|no longer waiting/.test(w);
  }));
  check(`${s}: the resolved card is folded and holds the request and Raw`, await p.evaluate(() => {
    const d = document.querySelector('.d-ask[data-state="resolved"]');
    return d && !d.open && !!d.querySelector(".d-raw") && d.textContent.includes("location.get");
  }));
  await p.close();
}
p = await open("screen=card-pending", phone);
check("the pending card's request has Raw", await p.evaluate(() => !!document.querySelector('.d-ask[data-state="pending"] .d-raw')));
check("the card's actions are buttons, named for the request", await p.evaluate(() => {
  const a = document.querySelector("[data-ask-allow]");
  return a.tagName === "BUTTON" && a.getAttribute("aria-label").includes("Location requested");
}));
check("the card is a region named for its request, and does not take focus", await p.evaluate(() => {
  const c = document.querySelector(".d-ask");
  return c.getAttribute("role") === "region" && c.getAttribute("aria-label") === "Location requested on this iPhone. Needs permission." && !c.contains(document.activeElement);
}));
await p.close();
p = await open("screen=mac-on&history=1");
check("records: each says what this device did and what it sent; an acknowledgement only for something sent", await p.evaluate(() => [...document.querySelectorAll(".d-record")].every((r) => {
  const sent = r.querySelector("[data-sent]").textContent;
  return r.querySelector("[data-did]").textContent && sent && (sent === "Sent nothing." ? !r.querySelector("[data-ack]") : !!r.querySelector("[data-ack]")?.textContent);
})));
check("records: a call the gateway timed out after it reached this Mac is kept, with what was sent and the ignored answer", !missing(await text(p, '[data-record="r4"]'), ["Ran it.", "Sent the result.", "The gateway ignored this device's answer."]));
check("records: a refusal's Raw holds its own request and the code and sentence actually sent", await p.evaluate(() => {
  const raw = document.querySelector('[data-record="r2"] .d-raw code').textContent;
  return raw.includes('"command": "reminders.list"') && raw.includes('"code": "NOT_ALLOWED_ON_DEVICE"') && raw.includes("Reminders is not allowed on Studio Mac.");
}));
check("records: an automatic refusal with no card is kept", (await text(p, ".d-records")).includes("Didn't run it: Reminders is Denied on this Mac."));
check("records: never name who asked", !/Otto asked|Otto wants|was told/.test(await text(p, ".d-records")));
await p.close();

// 5. One timing rule; one card per request; the 61-minute route -----------------------------

await walk("timed out: no Allow on the card; the app's row is the route, and changes the permission only", "screen=card-pending", [
  [link("The deadline passes"), "card-timedout", ["Timed out at 5:44 PM. This iPhone didn't run it. No permission was set by this request."]],
  [async (p) => check("timed out: the card offers no Allow", (await p.locator("[data-ask-allow]").count()) === 0), null],
  [link("Location in This iPhone"), "phone-on"],
  [async (p) => check("This iPhone lists the timed-out request: didn't run it, sent nothing", (await text(p, '[data-record="t1"]')).includes("Timed out at 5:44 PM. Didn't run it.") && (await text(p, '[data-record="t1"]')).includes("Sent nothing.") && (await p.locator('[data-record="t1"] [data-ack]').count()) === 0), null],
  [click('[data-allow="location"]'), "phone-on"],
  [async (p) => check("at 61 minutes, Allow on the row: Location Allowed, the request still closed, nothing sent", (await row(p, "location").getAttribute("data-local")) === "allowed" && (await text(p, '[data-record="t1"]')).includes("Didn't run it.") && (await text(p, '[data-record="t1"]')).includes("Sent nothing.")), null],
], phone);
// Each choice on each card first: the selected request is resolved with its own ID and accuracy; the other stays as it was.
const cardsOf = (p) => p.evaluate(() => [...document.querySelectorAll(".d-ask")].map((c) => `${c.dataset.req}|${c.dataset.accuracy}|${c.dataset.state}|${c.dataset.tag || ""}|${c.querySelector(".d-raw code")?.textContent.includes(c.dataset.req) && c.querySelector(".d-raw code")?.textContent.includes(c.dataset.accuracy)}`).join(" ; "));
p = await open("screen=card-pending&second=1", phone);
check("two requests make two cards, each with its own ID, parameters and deadline", (await cardsOf(p)) === "c41d…|balanced|pending||true ; e7a0…|precise|pending||true" && !missing(await text(p, '[data-card="c41d"]'), ["5:44:30 PM"]) && !missing(await text(p, '[data-card="e7a0"]'), ["5:45:10 PM"]));
await p.close();
for (const [first, other] of [["c41d", "e7a0"], ["e7a0", "c41d"]]) {
  for (const [choice, sel, tag] of [["Allow", "[data-ask-allow]", "Allowed"], ["Don't allow", "[data-ask-deny]", "Not allowed"]]) {
    const q = await open("screen=card-pending&second=1", phone);
    const acc = { c41d: "balanced", e7a0: "precise" };
    await q.locator(`[data-card="${first}"] ${sel}`).click();
    await at(q, "card-pending");
    const after = await cardsOf(q);
    const want = (id, state, t) => `${id}…|${acc[id]}|${state}|${t}|true`;
    const expect1 = [first, other].sort().map((id) => (id === first ? want(id, "resolved", tag) : want(id, "pending", ""))).join(" ; ");
    check(`${choice} on ${first} first: ${first} resolved with its own ID and accuracy; ${other} still pending with its own`, after === expect1, after);
    await q.locator(`[data-card="${other}"] [data-ask-allow]`).click();
    await at(q, "card-pending");
    const end = await cardsOf(q);
    const expect2 = [first, other].sort().map((id) => want(id, "resolved", id === first ? tag : "Allowed")).join(" ; ");
    check(`then the remaining ${other} answered: both resolved, neither reopens, ${first} keeps its outcome`, end === expect2 && (await q.locator('.d-ask[data-state="pending"]').count()) === 0, end);
    await q.close();
  }
}
// The local decision limit: a shorter budget, and the five-minute cap with each acknowledgement.
p = await open("screen=card-pending&budget=short", phone);
check("a 12-second budget: the card closes by its own local limit", (await text(p, ".d-ask-foot")) === "Clawtrate closes this card by 5:44:12 PM.");
await p.close();
for (const [ack, link_, words] of [
  ["accepted", "Five minutes pass; the refusal is accepted", "sent NO_ANSWER_ON_DEVICE; the gateway accepted it."],
  ["ignored", "Five minutes pass; the refusal is ignored", "sent NO_ANSWER_ON_DEVICE. The gateway ignored this device's answer."],
  ["none", "Five minutes pass; no acknowledgement", "sent NO_ANSWER_ON_DEVICE. Clawtrate couldn't confirm the gateway received it."],
]) {
  await walk(`a 10-minute budget: the five-minute cap comes first, NO_ANSWER_ON_DEVICE attempted, acknowledgement ${ack}`, "screen=card-pending&budget=cap", [
    [none, null, ["Clawtrate closes this card by 5:49:00 PM."]],
    [link(link_), "card-cap", ["No answer by 5:49 PM, this iPhone's five-minute limit.", words, "No permission was set by this request."]],
  ], phone);
}
p = await open("screen=card-pending&second=1", phone);
await p.locator('[data-card="c41d"] [data-ask-allow]').click();
await at(p, "card-pending");
await p.locator('[data-card="e7a0"] [data-ask-allow]').click();
await at(p, "card-pending");
check("two Allows: only the first says it set Location to Allowed", (await text(p, '[data-card="c41d"] [data-words]')).includes("This request set Location to Allowed.") && !(await text(p, '[data-card="e7a0"] [data-words]')).includes("This request set Location"));
await p.close();
p = await open("screen=mac-stopped");
check("after Stop: a confirmed cancellation, an unconfirmed one and a demonstrated effect, each in its own words", !missing(await text(p, ".d-records"), ["Started it. Stopped the operation: Calendar confirmed it.", "Started it. Clawtrate couldn't confirm whether it stopped.", "Sent the message before Stop."]));
check("after Stop: the node stopped and an app turned off are separate records", (await text(p, '[data-record="s4"]')).includes("Didn't run it: Clawtrate stopped answering on this Mac.") && (await text(p, '[data-record="s5"]')).includes("Didn't run it: Messages was turned off on this Mac."));
check("\"Stopped the operation\" only where the cancellation was confirmed", await p.evaluate(() => [...document.querySelectorAll(".d-record [data-did]")].filter((d) => d.textContent.includes("Stopped the operation")).every((d) => d.textContent.includes("confirmed it"))));
await p.close();
p = await open("screen=card-settings", phone);
check("turned off in Settings: Open Settings, no Allow", (await text(p)).includes("Open Settings") && (await p.locator("[data-ask-allow]").count()) === 0);
await p.close();

// 6. Stop and Turn off act on the device first ----------------------------------------------

await walk("Stop: the words, then stopped, with what the gateway was read to hold", "screen=mac-on&own=listed&app=messages", [
  [sw, "mac-stop", ["This Mac stops answering at once, here, whether or not the gateway can be reached.", "a message already sent stays sent"]],
  [click("[data-stop]"), "mac-stopped", ["Stopped on this Mac.", "The gateway lists this Mac as a device, not connected (read 5:40 PM).", "The gateway's allowlist still lists clawtrate.messages.read, clawtrate.messages.send (read 5:40 PM).", "The apps' decisions on this Mac stay as they were."]],
]);
await walk("Stop with the gateway unreachable: stopped here, status unknown", "screen=mac-stop&link=down", [
  [click("[data-stop]"), "mac-stopped", ["Stopped on this Mac. Gateway status couldn't be checked."]],
]);
await walk("Stop and remove, acknowledged", "screen=mac-stop", [
  [click("[data-also-remove]"), null],
  [click("[data-stop]"), "mac-stopped", ["Removed from the gateway (read 5:40 PM)."]],
]);
p = await open("screen=mac-stopped&removed=fail");
check("a failed removal: says so, and that it's stopped here", (await text(p)).includes("Couldn't remove it from the gateway") && (await text(p)).includes("It's stopped on this Mac."));
await p.close();
p = await open("screen=mac-stop&access=write");
check("stopping below admin: no node-pairing removal", (await p.locator("[data-also-remove]").count()) === 0);
await p.close();
p = await open("screen=mac-stop");
check("the removal option says what it removes, and the dialog says the operator sign-in and allowlist stay", (await text(p, "label.d-check")).trim() === "Also remove this Mac's node pairing from the gateway" && (await text(p, "[role=alertdialog]")).includes("This Mac's separate operator sign-in and the gateway's allowlist stay as read."));
await p.close();
// The saved node sign-in after Stop: no code, at write too; a confirmed removal clears it; an unknown one doesn't.
const codeStep = (p) => p.evaluate(() => document.body.textContent.includes("Getting this") || document.body.textContent.includes("one-time sign-in"));
{
  let sawCode = false;
  await walk("Stop only at write, then on again with the saved sign-in: a positive read-back and no code step", "screen=mac-on&access=write", [
    [sw, "mac-stop"],
    [click("[data-stop]"), "mac-stopped", ["Stopped on this Mac.", "This Mac keeps its saved device sign-in: turning it on again uses it, with no new code."]],
    [async (p) => check("stopped at write with a saved sign-in: the switch is available, with no admin request", (await p.locator(".b-switch[data-go]").count()) === 1 && (await p.getByRole("button", { name: "Request admin access" }).count()) === 0), null],
    [sw, "mac-confirm", ["Clawtrate will connect with this Mac's saved device sign-in."]],
    [async (p) => (sawCode ||= await codeStep(p)), null],
    [click("[data-host-confirm]"), "mac-steps", ["Connecting with this Mac's saved device sign-in"]],
    [async (p) => { sawCode ||= await codeStep(p); check("saved sign-in: only the connect and the read-back steps, the switch not checked", (await stepStates(p)) === "running,waiting" && (await switchOff(p))); }, null],
    [link("The node's hello arrives"), "mac-steps", ["Requests to this Mac wait until it is read."]],
    [async (p) => (sawCode ||= await codeStep(p)), null],
    [link("The read-back agrees"), "mac-on", ["The gateway listed Studio Mac (bots) as connected at 5:31 PM."]],
  ]);
  check("the saved-sign-in path never asked for a code", !sawCode);
}
await walk("Stop and remove, confirmed: the sign-in cleared; below admin the switch needs admin and the records stay", "screen=mac-stop", [
  [click("[data-also-remove]"), null],
  [click("[data-stop]"), "mac-stopped", ["Removed from the gateway (read 5:40 PM).", "this Mac's device sign-in was cleared"]],
  [async (p) => check("after a confirmed removal, saved is cleared", (await param(p, "saved")) === null), null],
]);
p = await open("screen=mac-stopped&removed=1&access=write");
check("confirmed removal, below admin: the switch is unavailable and the recorded requests are still visible", (await p.locator(".b-switch").getAttribute("aria-disabled")) === "true" && (await p.locator(".d-record").count()) >= 5 && (await text(p)).includes("Requests to this device"));
await p.close();
p = await open("screen=mac-stopped&link=down&saved=1");
check("stopped with the gateway unreachable: the records are still on the page", (await p.locator(".d-record").count()) >= 5 && (await text(p)).includes("Gateway status couldn't be checked."));
await p.close();
await walk("an unknown removal keeps the saved sign-in; its later refusal is the sign-in refusal, never a new credential", "screen=mac-stop&link=down", [
  [click("[data-also-remove]"), null],
  [click("[data-stop]"), "mac-stopped", ["Clawtrate couldn't confirm the removal.", "This Mac keeps its saved device sign-in"]],
  [sw, "mac-confirm"],
  [click("[data-host-confirm]"), "mac-steps"],
  [link("The gateway refuses the saved sign-in"), "mac-refused", ["The gateway refused this Mac's device sign-in."]],
  [async (p) => check("after the refusal: no saved sign-in, and no code was requested on the way", (await param(p, "saved")) === null && !(await codeStep(p))), null],
]);
p = await open("screen=mac-refused&access=write");
check("a refused sign-in below admin: recovery needs admin, and nothing is minted", (await p.locator(".b-switch").getAttribute("aria-disabled")) === "true" && (await text(p)).includes("needs admin access"));
await p.close();
for (const [screen, opts] of [["mac-on&allowed=calendar&own=listed&local=allowed&app=messages", {}], ["phone-on&history=1&allowed=location", phone]]) {
  p = await open(`screen=${screen}`, opts);
  check(`${screen.split("&")[0]}: every Allowed app has its own Turn off`, await p.evaluate(() => {
    const rows = [...document.querySelectorAll('.d-app[data-local="allowed"]')];
    return rows.length >= 2 && rows.every((r) => r.querySelector(`[data-turnoff="${r.dataset.app}"]`));
  }));
  await p.close();
}
await walk("Turn off Messages: Denied here, still listed by the gateway", "screen=mac-messages-on&own=listed&local=allowed", [
  [click('[data-turnoff="messages"]'), "mac-on"],
  [async (p) => check("turned off: Messages Denied on this Mac, gateway line unchanged", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]');
    return r.dataset.local === "denied" && r.dataset.gateway === "listed";
  })), null],
]);
await walk("Remove Messages from the allowlist: the words, each read apart, this Mac's decision kept", "screen=mac-messages-on&own=listed&local=allowed", [
  [click('[data-remove="messages"]'), "mac-messages-remove"],
  [async (p) => check("the removal confirmation names the commands and claims no more than the policy change", (await text(p, "[role=alertdialog]")).includes("Remove clawtrate.messages.read and clawtrate.messages.send from the gateway-wide allowlist? If that removes the commands from the active policy, the gateway can end waiting calls and refuse later calls for them. An operation this Mac already started may finish. This Mac keeps its Messages choice.") && !(await text(p, "[role=alertdialog]")).includes("any device")), null],
  [click("[data-confirm]"), "mac-messages-removed", ["Removed from the gateway's allowlist.", "The gateway's stored settings no longer list clawtrate.messages.read and clawtrate.messages.send (read 5:41 PM).", "The gateway no longer lists them for Studio Mac (bots) (read 5:41 PM)."]],
  [async (p) => check("removed: Messages Not listed, still Allowed on this Mac", await p.evaluate(() => {
    const r = document.querySelector('[data-app="messages"]');
    return r.dataset.gateway === "notlisted" && r.dataset.local === "allowed";
  })), null],
  [link("Only the stored settings show it gone"), "mac-messages-removed", ["The gateway still lists them for Studio Mac (bots) (read 5:41 PM)."]],
  [async (p) => check("stored-only: the row still reads the active listing", (await row(p, "messages").getAttribute("data-gateway")) === "listed"), null],
  [link("Only the active listing shows it gone"), "mac-messages-removed", ["Clawtrate couldn't confirm the allowlist edit.", "The gateway's stored settings still list clawtrate.messages.read and clawtrate.messages.send (read 5:41 PM)."]],
  [async (p) => check("active-only: not reported as removed", !(await text(p)).includes("Removed from the gateway's allowlist.")), null],
  [link("The allowlist can't be read"), "mac-messages-removed", ["Couldn't read the gateway's allowlist.", "Clawtrate couldn't confirm the allowlist edit."]],
]);
p = await open("screen=mac-messages-on&own=listed&access=write");
check("below admin: no Remove from the allowlist", (await p.locator("[data-remove]").count()) === 0);
await p.close();
await walk("back after a refusal received while inactive, then after an unobserved disconnection", "screen=phone-back", [
  [none, null, ["Connected as a device for bots (read 5:46 PM).", "Didn't run it: Clawtrate wasn't active on this iPhone.", "NOT_OPEN_ON_DEVICE", "Ran it, before Clawtrate left the foreground."]],
  [async (p) => check("after a received refusal: no claim about what never arrived", !/never reached|isn't known/.test(await text(p))), null],
  [link("The app was suspended and its socket closed"), "phone-back", ["While Clawtrate was suspended, whether requests were delivered to this iPhone, and when the gateway saw its socket close, isn't known.", "The gateway last saw the earlier connection at 5:12 PM (disconnect)."]],
  [async (p) => check("after an unobserved disconnection: only what this iPhone received is recorded, and no background refusal is invented", (await p.locator(".d-record").count()) === 1 && !(await text(p)).includes("wasn't active") && !/never reached/.test(await text(p))), null],
], phone);
p = await open("screen=phone-on", phone);
check("This iPhone, on: connected only with the local hello and a positive read, each stated", (await text(p, ".d-state")).includes("Connected as a device for bots (read 5:31 PM).") && (await text(p, ".d-state")).includes("This iPhone's node socket has a hello, and the gateway listed iPhone (bots) as connected at 5:31 PM.") && !(await text(p)).includes("Connected while Clawtrate is open"));
await p.close();

// 7. A positive read-back for each stage (other devices) -------------------------------------

await walk("another device approved: the confirmation predicts no commands; the device entry confirms the role", "screen=machines", [
  [none, null, ["Kitchen iPad requests the node role."]],
  [click('[data-request="ipad"] button[data-variant="primary"]'), "machines", ["Approve Kitchen iPad as a device for bots?", "Its commands are a separate request, approved separately."]],
  [click("[data-confirm]"), "machines", ["Kitchen iPad's device entry lists the node role (read 5:22 PM)."]],
]);
await walk("another device's commands: exact IDs, the admin line, then confirmed by their present listing", "screen=machines", [
  [none, null, ["Workshop PC requests location.get, system.run, fs.listDir. These commands need admin approval.", "If approved and permitted, these commands can run a program or list files on Workshop PC."]],
  [click('[data-request="pc"] button[data-variant="primary"]'), "machines", ["Workshop PC requests location.get, system.run, fs.listDir. If approved and permitted, these commands can run a program or list files on Workshop PC."]],
  [click("[data-confirm]"), "machines", ["The gateway lists these commands for Workshop PC (read 5:22 PM)"]],
]);
p = await open("screen=machines");
check("Machines: a pending declaration is not promoted to what the device offers", !/also offers|asks to offer|read files on it/.test(await text(p)));
await p.close();
for (const [who, q] of [["ipad", "ipad=refused"], ["pc", "pc=refused"]]) {
  p = await open(`screen=machines&${q}`);
  check(`a refused decision on ${who}: the refusal shown, the same request's row retained and still pending`, (await p.locator(`[data-request="${who}"]`).count()) === 1 && (await text(p, `[data-request="${who}"]`)).includes("The gateway refused the approval:") && (await text(p, `[data-request="${who}"]`)).includes("The request is still pending (read 5:22 PM).") && !(await text(p)).includes("no longer pending"));
  await p.close();
}
await walk("a request that disappears with a successful read: no longer pending", "screen=machines", [[link("The request disappears with no event"), "machines", ["The request is no longer pending (read 5:22 PM)."]]]);
await walk("a request that disappears and the read fails: never 'no longer pending'", "screen=machines", [
  [link("It disappears, and the read fails"), "machines", ["Couldn't read the gateway. Clawtrate can't tell what happened to Kitchen iPad's request."]],
  [async (p) => check("a missing request with a failed read says nothing about its decision", !/no longer pending|rejected|is paired|lists the node role/.test(await text(p, "[data-after]"))), null],
]);
await walk("a rejection is said from the event matched to the request's ID", "screen=machines", [[click('[data-request="ipad"] button[data-variant="quiet"]'), "machines", ["The gateway reported request 5d2e… rejected (device.pair.resolved, 5:22 PM)."]]]);
p = await open("screen=machines&ipad=approved&readfail=1");
check("a failed read never says approved", (await text(p)).includes("Couldn't read the gateway.") && !/is paired|lists the node role/.test(await text(p)));
await p.close();
for (const [acc, words, rows] of [
  ["read", "Seeing paired devices needs device access.", 0],
  ["write", "Seeing paired devices needs device access.", 0],
  ["pairing", "Only this device's own records are listed. Seeing other devices needs admin access.", 1],
  ["admin", "", 3],
]) {
  p = await open(`screen=machines&access=${acc}`);
  const paired = await text(p, "[data-paired]");
  check(`Paired devices at ${acc}: ${rows === 3 ? "the whole list" : rows ? "this device's own records only" : "the device-access line, no list"}`, (await p.locator("[data-paired] .facts > div").count()) === rows && (!words || paired.includes(words)) && (acc === "admin" || !paired.includes("(bots)")));
  if (acc !== "admin")
    check(`requests at ${acc}: the admin line, never a list`, (await text(p)).includes("Approving other devices for bots needs admin access.") && (await p.locator(".d-request").count()) === 0);
  await p.close();
}
// The own node's changed-command path: compared again, approved by request ID, then the final read.
await walk("own node's pending commands: compared against the declaration, then the resulting commands are read", "screen=mac-steps&fail=pending", [
  [none, null, ["Compared with this Mac's declaration at 5:31 PM: calendar.events and reminders.list are declared"]],
  [click("[data-approve-own]"), "mac-steps", ["Approved request 7a1c…. Reading the resulting commands"]],
  [async (p) => check("after approving, the read-back step is still running: approving is not listing", (await stepStates(p)) === "done,done,running" && (await switchOff(p))), null],
  [link("It lists an extra command"), "mac-steps", ["The gateway lists commands this Mac doesn't offer. Clawtrate disconnected it."]],
]);
await walk("own node's request changed since it was read: nothing approved", "screen=mac-steps&fail=pending", [
  [link("The request changed since it was read"), "mac-steps", ["The pending request changed since Clawtrate read it. Clawtrate approved nothing.", "system.run"]],
  [async (p) => check("a changed request offers no approval", (await p.locator("[data-approve-own]").count()) === 0), null],
]);

// 8. The share sheet: the edited note travels; a lost reply is not sent twice ----------------

{
  const q = await open("screen=share", phone);
  check("share: the sheet's title takes focus", await q.evaluate(() => document.activeElement?.id === "d-share-title"));
  await q.fill("[data-note]", "Edited: take the north trail.");
  await q.locator("[data-to-row]").click();
  check("share: choosing a bot opens the radio group", await at(q, "share-to"));
  check("share-to: one tab stop", (await q.locator('[role=radio][tabindex="0"]').count()) === 1);
  await q.locator('[role=radio][aria-checked="true"]').focus();
  await q.keyboard.press("ArrowDown");
  check("share-to: Down moves to and chooses the next bot", await q.evaluate(() => document.activeElement?.dataset.to === "marlow" && document.activeElement.getAttribute("aria-checked") === "true"));
  await q.keyboard.press("ArrowDown");
  await q.locator("[data-to-done]").click();
  check("share: back with Otto chosen and the note as edited", (await at(q, "share")) && (await q.inputValue("[data-note]")) === "Edited: take the north trail." && (await text(q)).includes("Send starts a new task with Otto, with the note and 2 items."));
  await q.close();
}
{
  const q = await open("screen=share&link=down", phone);
  await q.fill("[data-note]", "Edited before a no-send.");
  await q.locator("[data-share-send]").click();
  check("a known no-send: says nothing was sent", (await at(q, "share-cant")) && (await text(q)).includes("Nothing was sent."));
  await q.locator("[data-open-draft]").click();
  check("Open in Clawtrate: the composer holds the note exactly as edited, unsent", (await at(q, "share-draft")) && (await q.inputValue("[data-draft]")) === "Edited before a no-send." && (await text(q)).includes("Nothing has been sent."));
  await q.close();
}
await walk("a lost reply on the matching start: couldn't confirm; Check again uses the original send; no draft offered", "screen=share", [
  [link("The reply will be lost"), "share"],
  [click("[data-share-send]"), "share-unsure", ["Clawtrate couldn't confirm whether the gateway received this.", "Check again uses the original send."]],
  [async (p) => check("a lost reply offers no Open in Clawtrate", (await p.locator("[data-open-draft]").count()) === 0 && !(await text(p)).includes("Open in Clawtrate")), null],
  [async (p) => check("a submitted share offers Close, not Cancel", (await p.locator("[data-close]").count()) === 1 && (await p.getByRole("link", { name: "Cancel", exact: true }).count()) === 0), null],
  [click("[data-check-again]"), "share-sent", ["Sent to Juniper"]],
], phone);
for (const [label, query] of [
  ["the key's window passed", "late=1"],
  ["a changed gateway start", "start=changed"],
  ["a missing boot ID", "start=missing"],
  ["changed credentials", "cred=changed"],
]) {
  p = await open(`screen=share-unsure&${query}`, phone);
  check(`a lost reply with ${label}: no Check again, no Open in Clawtrate, Open Juniper to that bot's list`, await p.evaluate(() => {
    const open = document.querySelector("[data-open-bot]");
    return !document.querySelector("[data-check-again]") && !document.querySelector("[data-open-draft]") && !document.body.textContent.includes("Open in Clawtrate") && open?.textContent === "Open Juniper" && open.getAttribute("href") === "app.html?bot=juniper";
  }) && (await text(p)).includes("Clawtrate still couldn't confirm it. Look in Juniper's tasks before sending again."));
  await p.close();
}
await walk("Close from the submitted unknown state keeps its uncertainty", "screen=share-unsure", [
  [click("[data-close]"), "share-closed", ["Closed. Clawtrate couldn't confirm whether it was sent."]],
  [async (p) => check("a closed unknown share never says nothing was sent", !(await text(p)).includes("Nothing was sent.")), null],
], phone);
await walk("Cancel before submission closes the sheet and says nothing was sent", "screen=share", [
  [click("[data-cancel]"), "share-closed", ["Nothing was sent."]],
  [async (p) => check("closed: no sheet left", (await p.locator(".d-share").count()) === 0), null],
], phone);
// A created task is told apart from sending its first message; the handoff never makes a second task.
for (const [label, link_, screen, words, held, heldWords] of [
  ["the message refused", "The task is made, the message refused", "share-msgfail", "Juniper's task was created. The gateway refused the message.", "refused", "The gateway refused the message."],
  ["the message not confirmed", "Only the task is confirmed", "share-taskonly", "Juniper's task was created. Clawtrate couldn't confirm the message.", "unconfirmed", "Clawtrate couldn't confirm the message."],
]) {
  const q = await open("screen=share", phone);
  await q.fill("[data-note]", "Edited: meet at the north gate.");
  await q.getByRole("link", { name: link_, exact: true }).click();
  check(`a created task with ${label}: never "Sent", and says the task was created`, (await at(q, screen)) && (await text(q)).includes(words) && !/Sent to/.test(await text(q)));
  await q.locator("[data-open-task]").click();
  check(`${label}: opens the returned task, with the exact first message and items held there`, (await at(q, "share-task")) && (await param(q, "held")) === held && (await q.locator('[data-task="4f2a…"]').count()) === 1 && (await text(q, "[data-held-text]")) === "Edited: meet at the north gate." && (await q.locator("[data-held] .d-chips li").count()) === 2 && (await text(q)).includes(heldWords) && !/Sent to|New task/.test(await text(q)));
  if (held === "refused") {
    await q.locator("[data-retry-held]").click();
    check("its retry goes to the same task, not a new one", (await at(q, "share-task")) && (await q.locator('[data-task="4f2a…"]').count()) === 1 && (await text(q, "[data-held-text]")) === "Edited: meet at the north gate.");
  }
  await q.close();
}
// The unaddressed draft: reached from no gateway or a bot no longer listed; the picker selects without sending.
for (const [label, query, words] of [
  ["no gateway", "gw=none", "No gateway is saved in Clawtrate."],
  ["no destination", "gone=1", "Juniper is no longer listed."],
]) {
  const q = await open(`screen=share&${query}`, phone);
  await q.fill("[data-note]", "Edited before choosing a bot.");
  await q.locator("[data-share-send]").click();
  check(`${label}: says which, and nothing was sent`, (await at(q, "share-cant")) && !missing(await text(q), [words, "Nothing was sent."]));
  await q.locator("[data-open-draft]").click();
  check(`${label}: the draft has no bot, a picker before Send, and Send unavailable`, (await at(q, "share-draft")) && (await param(q, "nobot")) === "1" && (await q.locator("[data-radios] [role=radio]").count()) === 4 && (await q.locator("[data-draft-send][disabled]").count()) === 1);
  await q.fill("[data-draft]", "Edited again in the draft.");
  await q.locator('[data-radios] [data-to="marlow"]').click();
  check(`${label}: choosing Marlow selects it, keeps the edited note and the items, and sends nothing`, (await at(q, "share-draft")) && (await param(q, "to")) === "marlow" && (await param(q, "nobot")) === null && (await q.inputValue("[data-draft]")) === "Edited again in the draft." && (await q.locator(".d-composer .d-chips li").count()) === 2 && (await text(q)).includes("Nothing has been sent.") && !/Sent to/.test(await text(q)) && (await q.locator("[data-draft-send]:not([disabled])").count()) === 1);
  await q.close();
}
p = await open("screen=share-draft&nobot=1&nobots=1", phone);
check("no selectable bot: the draft is kept and Send stays unavailable", (await text(p)).includes("No bot is listed to send this to.") && (await p.inputValue("[data-draft]")) === "For Saturday's route." && (await p.locator("[data-draft-send][disabled]").count()) === 1 && (await p.locator("[role=radio]").count()) === 0);
await p.close();
for (const choice of ["", "&to=marlow"]) {
  p = await open(`screen=share&nobots=1${choice}`, phone);
  check("F-245 an empty list leaves To empty and Send disabled", (await p.locator("[data-to-empty]").count()) === 1 && await p.locator("[data-share-send]").isDisabled());
  await p.locator("[data-to-row]").click();
  check("F-245 the empty picker offers no recipient", (await p.getByRole("radio").count()) === 0);
  await p.locator("[data-to-done]").click();
  check("F-245 returning from the empty picker keeps Send disabled", await p.locator("[data-share-send]").isDisabled());
  await p.close();
}
for (const tier of ["read", "pairing"]) {
  p = await open(`screen=share&access=${tier}&to=marlow&lost=1`, phone);
  await p.fill("[data-note]", "Keep the route.");
  await p.locator("[data-share-send]").click();
  check(`F-406 ${tier} without write: explain the refusal before sending`, (await at(p, "share-cant")) && !missing(await text(p), ["Sending needs write access", "Nothing was sent."]));
  await p.locator("[data-open-draft]").click();
  check(`F-406 ${tier} without write: keep the note, items and recipient in an unsent draft`, (await p.inputValue("[data-draft]")) === "Keep the route." && (await text(p, ".d-chat-head")).includes("Marlow") && (await p.locator(".d-chips li").count()) === 2 && await p.locator("[data-draft-send]").isDisabled());
  await p.close();
}
for (const screen of ["share-msgfail", "share-taskonly", "share-task", "share-unsure", "share-sent"]) {
  p = await open(`screen=${screen}&nodefault=1&note=Keep%20this&said=Sent`, phone);
  check(`F-406 ${screen} without a recipient keeps an unsent draft`, (await p.inputValue("[data-draft]")) === "Keep this" && await p.locator("[data-draft-send]").isDisabled() && !(await text(p)).includes("undefined") && !(await text(p, "#device-live")));
  await p.close();
}
for (const [outcome, control] of [["share-unsure", "[data-check-again]"], ["share-sent", "[data-close]"], ["share-msgfail", "[data-open-task]"], ["share-taskonly", "[data-open-task]"], ["share-task", "[data-held]"]]) {
  p = await open(`screen=${outcome}&to=marlow&nobots=1`, phone);
  check(`F-406 ${outcome} keeps the submitted outcome after the bot list empties`, (await p.locator("#device-root").getAttribute("data-screen")) === outcome && (await p.locator(control).count()) === 1 && (await p.locator("[data-draft-send]").count()) === 0);
  await p.close();
}
p = await open("screen=share&lost=1", phone);
await p.locator("[data-share-send]").click();
check("F-406 sending to the default bot records the original recipient for recovery", (await at(p, "share-unsure")) && (await param(p, "to")) === "juniper");
await p.close();
for (const screen of ["siri-confirm", "siri-sent"]) {
  p = await open(`screen=${screen}&nobots=1&msg=Keep%20these%20words`, phone);
  check(`F-246 ${screen} without a listed bot offers only the draft handoff`, (await p.locator("[data-siri-send]").count()) === 0 && (await text(p, ".d-sys")).includes("Choose a bot in Clawtrate"));
  await p.locator("[data-siri-handoff]").click();
  check(`F-246 ${screen} keeps the original text until a bot is listed`, (await p.inputValue("[data-draft]")) === "Keep these words" && await p.locator("[data-draft-send]").isDisabled());
  await p.close();
}
p = await open("screen=share&nodefault=1", phone);
check("defaultId not among the listed bots: To starts empty, asks for a listed bot, and Send is unavailable", (await text(p, "[data-to-row]")).includes("Choose a listed bot") && (await p.locator("[data-share-send][disabled]").count()) === 1 && !(await text(p)).includes("The primary bot"));
await p.close();
p = await open("screen=share&big=1", phone);
check("an over-limit item shows its reason and is left out of the send preview", (await text(p, "[data-excluded]")).includes("Can't be sent: larger than the composer's limit") && (await text(p, "[data-preview]")).includes("the note and 2 items; trail-video.mov is left out"));
await p.close();
p = await open("screen=share-unsure", phone);
check("a lost reply never uses the created-task or draft path", (await p.locator("[data-open-task], [data-open-draft]").count()) === 0 && !/task was created/.test(await text(p)));
await p.close();
p = await open("screen=share-draft&nobot=1", phone);
check("a draft with no bot asks which, and can't be sent until chosen", (await text(p)).includes("This draft has no bot yet.") && (await p.locator(".d-composer button[disabled]").count()) === 1);
await p.close();
p = await open("screen=share", phone);
check("share: a link is text, never a link", (await p.locator('.d-chips a[href^="http"]').count()) === 0);
check("share: the sent words claim acceptance only", !(await (async () => { const q = await open("screen=share-sent", phone); const t = await text(q); await q.close(); return /can read|will read|read the picture/.test(t); })()));
await p.close();

// 9. Siri on a locked phone, and the handoff until the confirmation is proven ----------------

for (const [action, after, words] of [
  ["list", "siri-list", "You have four bots"],
  ["send", "siri-confirm", "Send to Juniper?"],
]) {
  await walk(`locked, ${action === "list" ? "List Bots" : "Send Message"}: the system's prompt with no Clawtrate content, then unlock returns to that action`, `screen=siri-locked&action=${action}`, [
    [async (p) => check(`locked ${action}: no bot name, message text or result before unlock`, (await text(p, ".d-sys-caption")).includes("The system's unlock prompt") && !/Juniper|Marlow|Otto|Pip|water the plants|four bots|Sent/.test(await text(p, ".d-sys")) && (await p.locator(".d-sys [data-cancel]").count()) === 1), null],
    [click("[data-unlocked]"), after, [words]],
  ], phone);
}
await walk("locked: Cancel closes and sends nothing", "screen=siri-locked&action=send", [[click("[data-cancel]"), "siri-closed", ["Closed. Nothing was sent."]]], phone);
for (const screen of ["siri-locked", "siri-list", "siri-list-fail", "siri-confirm", "siri-sent", "siri-fail", "siri-cancelled"]) {
  p = await open(`screen=${screen}`, phone);
  check(`${screen}: the system panel has Close or Cancel`, (await p.locator(".d-sys [data-cancel]").count()) === 1);
  await p.close();
}
p = await open("screen=siri-list", phone);
for (let i = 0; i < 6; i += 1) await p.keyboard.press("Tab");
check("List Bots' result keeps Tab inside", await p.evaluate(() => !!document.activeElement.closest(".d-sys")));
await p.keyboard.press("Escape");
check("List Bots' result is dismissed by Escape, sending nothing", (await at(p, "siri-closed")) && (await text(p)).includes("Nothing was sent."));
await p.close();
for (const screen of ["siri-sent", "siri-fail"]) {
  p = await open(`screen=${screen}`, phone);
  check(`${screen}: marked as not a supported Send Message state before the device proof`, (await text(p, ".d-sys")).includes("Not a supported Send Message state until the confirmation is proven on a device."));
  await p.close();
}
await walk("Send Message: the bot and the exact text first; the shipped path hands off a draft, unsent", "screen=siri-confirm&msg=Exactly%20these%20words.", [
  [none, null, ["Send to Juniper?", "Exactly these words."]],
  [click("[data-siri-handoff]"), "share-draft", ["From Send Message. Nothing has been sent."]],
  [async (p) => check("the handoff's composer holds the exact text", (await p.inputValue("[data-draft]")) === "Exactly these words."), null],
], phone);
await walk("Send Message: Cancel sends nothing", "screen=siri-confirm", [[click("[data-cancel]"), "siri-cancelled", ["Nothing was sent."]]], phone);
p = await open("screen=siri-confirm", phone);
check("Send Message: the send path is marked as waiting for proof on a device", (await text(p, ".d-proto")).includes("Once the confirmation is proven on a device: Send"));
await p.close();
await walk("Send Message, once proven: sent; unreachable: Open in Clawtrate", "screen=siri-confirm&link=down", [
  [click("[data-siri-send]"), "siri-fail", ["Clawtrate couldn't send this"]],
  [link("Open in Clawtrate"), "share-draft", ["From Send Message. Nothing has been sent."]],
], phone);
p = await open("screen=siri-confirm&access=read", phone);
await p.locator("[data-siri-send]").click();
check("F-246 the future Siri send reports missing write access", (await at(p, "siri-fail")) && (await text(p, ".d-sys")).includes("sending needs write access"));
await p.close();
p = await open("screen=siri-sent", phone);
await p.keyboard.press("Escape");
check("F-246 closing an accepted Siri result preserves its outcome", (await at(p, "siri-closed")) && (await text(p, "[data-closed]")) === "Closed.");
await p.close();
p = await open("screen=siri-list", phone);
check("List Bots: the names, the primary bot first", (await text(p)).includes("You have four bots: Juniper, Marlow, Otto and Pip."));
await p.close();
p = await open("screen=siri-list-fail", phone);
check("List Bots, unreachable: no list from memory", (await text(p)).includes("Clawtrate couldn't reach the gateway.") && (await p.locator(".d-sys li").count()) === 0);
await p.close();

// 10. Supplied names stay text; focus; layout -------------------------------------------------

p = await open("screen=mac-on&devname=" + encodeURIComponent('<em data-supplied="1">Mac</em>'));
check("a supplied device name stays text, never markup", (await p.locator("[data-supplied]").count()) === 0 && (await text(p)).includes('<em data-supplied="1">Mac</em> (bots)'));
await p.close();
p = await open("screen=card-pending&taskname=" + encodeURIComponent('<img data-supplied="1" src="x">'), phone);
check("a supplied task name stays text, never markup", (await p.locator("[data-supplied]").count()) === 0 && (await text(p, ".d-ask")).includes('<img data-supplied="1" src="x">'));
await p.close();
p = await open("screen=mac-messages-confirm");
for (let i = 0; i < 6; i += 1) await p.keyboard.press("Tab");
check("a dialog keeps Tab inside", await p.evaluate(() => !!document.activeElement.closest(".d-dialog")));
await p.keyboard.press("Shift+Tab");
check("a dialog keeps Shift+Tab inside", await p.evaluate(() => !!document.activeElement.closest(".d-dialog")));
await p.close();
p = await open("screen=mac-confirm");
check("the host's dialog takes focus on its title, and the page behind is inert", await p.evaluate(() => document.activeElement?.id === "s-host-title" && document.querySelector(".b-settings").inert));
for (let i = 0; i < 5; i += 1) await p.keyboard.press("Tab");
check("the host's dialog keeps Tab inside", await p.evaluate(() => !!document.activeElement.closest(".s-host")));
await p.keyboard.press("Escape");
check("Escape on the host's dialog is its Cancel", await at(p, "mac-off"));
await p.close();
p = await open("screen=share", phone);
for (let i = 0; i < 8; i += 1) await p.keyboard.press("Tab");
check("the share sheet keeps Tab inside", await p.evaluate(() => !!document.activeElement.closest(".d-share")));
await p.close();
p = await open("screen=mac-on&history=1");
check("row actions are named for their app", await p.evaluate(() => !!document.querySelector('[aria-label="Allow Calendar"]') && !!document.querySelector('[aria-label="Turn off Location"]') && !!document.querySelector('[aria-label="Add Messages to the gateway\'s allowlist"]')));
check("row actions are buttons", await p.evaluate(() => [...document.querySelectorAll("[data-allow], [data-turnoff], [data-add]")].every((el) => el.tagName === "BUTTON")));
await p.close();
p = await open("screen=phone-on&width=full", { width: 1440, height: 900 });
check("This iPhone at desktop width: one pane, the section uses the width", await p.evaluate(() => document.querySelector(".b-section").getBoundingClientRect().width > 900 && !document.querySelector(".b-nav")));
await p.close();
p = await open("screen=mac-request");
check("a request that named no task: in Requests to this device, with the banner", !missing(await text(p), ["A request for Calendar on this Mac", "Requests to this device", "The request names no task."]));
await p.locator("[data-ask-allow]").click();
check("that request allowed: said in place with what the gateway acknowledged", (await at(p, "mac-request")) && (await text(p)).includes("the gateway accepted the answer. This request set Calendar to Allowed."));
await p.close();

// Every state, at desktop and phone width, light and dark ------------------------------------

p = await open("screen=mac-off");
const screens = await p.evaluate(() => window.CT.deviceScreens);
await p.close();
check("the page lists its states", screens.length >= 45, String(screens.length));
const banned = /\b(safe|secure|securely|private|protected|Resumed)\b|your own chat|own chats|Otto wants|Otto asked|was told/i;
// A request's origin is never established (section 2's second rule): no state may claim one, a chat's kind included.
const provenance = /\b(direct|group|private|cron) (request|chat|task|message)s?\b|\b(from|in) (a|your|the|this) (group|chat|direct)\b|\bcame from\b|\b(sent|asked|requested) by\b|\bon behalf of\b/i;
for (const [label, width] of [["1440", 1440], ["1100", 1100], ["800", 800], ["390", 390]]) {
  const bad = [];
  const words = [];
  const errors = [];
  const claims = [];
  for (const screen of screens) {
    for (const theme of ["light", "dark"]) {
      const q = await open(`screen=${screen}${label === "390" ? "&width=phone" : "&width=full"}`, { width, height: 844, theme });
      if (!(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) bad.push(`${screen}/${theme}`);
      if (theme === "light" && banned.test(await text(q))) words.push(screen);
      if (theme === "light" && provenance.test(await text(q))) claims.push(screen);
      if (q.errors.length) errors.push(`${screen}: ${q.errors[0]}`);
      if (theme === "dark" && !(await q.evaluate(() => document.documentElement.dataset.theme === "dark"))) errors.push(`${screen}: not dark`);
      await q.close();
    }
  }
  check(`every state at ${label}: no sideways scroll`, bad.length === 0, bad.join(" "));
  check(`every state at ${label}: no page errors`, errors.length === 0, errors.join(" | "));
  check(`every state at ${label}: none of the words the design rules out`, words.length === 0, words.join(" "));
  check(`every state at ${label}: no claim of where a request came from`, claims.length === 0, claims.join(" "));
}
p = await open("screen=card-pending&width=phone", phone);
check("phone: the card's buttons are touch-sized", await p.evaluate(() => [...document.querySelectorAll(".d-ask .d-actions .button")].every((el) => el.getBoundingClientRect().height >= 44)));
await p.close();
p = await open("screen=phone-on&width=phone", phone);
check("phone: app rows are 72 px or taller", await p.evaluate(() => [...document.querySelectorAll(".d-app")].every((el) => el.getBoundingClientRect().height >= 72)));
await p.close();

// The gallery, the index and the bar reach this page -----------------------------------------

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
