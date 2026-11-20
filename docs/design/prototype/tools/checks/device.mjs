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
  [none, null, ["Needs permission", "Allow gets your location for this request, and lets every later request for Location that reaches this iPhone get it, until you turn it off.", "This request can be answered until 5:44:30 PM."]],
  [click("[data-ask-allow]"), "card-sent", ["This iPhone got your location and sent it at 5:44 PM; the gateway accepted the answer."]],
], phone);
await walk("the card: an answer the gateway ignored says the operation ran", "screen=card-pending", [
  [link("Allow, then the gateway ignores the answer"), "card-ignored", ["This iPhone got your location and sent it at 5:44 PM, but the gateway ignored the answer: it was no longer waiting for this request."]],
], phone);
await walk("the card: no acknowledgement says it couldn't confirm", "screen=card-pending", [
  [link("Allow, and no acknowledgement"), "card-unconfirmed", ["Clawtrate couldn't confirm the gateway received it."]],
], phone);
await walk("the card: Don't allow, refusal accepted", "screen=card-pending", [
  [click("[data-ask-deny]"), "card-dontallow", ["This iPhone didn't run the request and sent the refusal NOT_ALLOWED_ON_DEVICE; the gateway accepted it."]],
], phone);
await walk("the card: Don't allow, refusal ignored", "screen=card-pending", [
  [link("Don't allow, and the gateway ignores it"), "card-dontallow", ["The gateway ignored the refusal: it was no longer waiting."]],
], phone);
await walk("the card: turned off on this iPhone while it waited", "screen=card-pending", [
  [link("Turn off Location on this iPhone"), "card-turnedoff", ["Location was turned off on this iPhone while the request waited.", "TURNED_OFF_ON_DEVICE"]],
], phone);
for (const s of ["card-sent", "card-ignored", "card-unconfirmed", "card-dontallow", "card-turnedoff", "card-timedout"]) {
  p = await open(`screen=${s}`, phone);
  const t = await text(p);
  check(`${s}: never says what a caller received, never "Resumed"`, !/was told|Resumed|reached Otto|Otto got/.test(t));
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
check("records: each says what this device did, what it sent and what the gateway acknowledged", await p.evaluate(() => [...document.querySelectorAll(".d-record")].every((r) => r.querySelector("[data-did]").textContent && r.querySelector("[data-sent]").textContent && r.querySelector("[data-ack]").textContent)));
check("records: an automatic refusal with no card is kept", (await text(p, ".d-records")).includes("Didn't run it: Reminders is Denied on this Mac."));
check("records: never name who asked", !/Otto asked|Otto wants|was told/.test(await text(p, ".d-records")));
await p.close();

// 5. One timing rule; one card per request; the 61-minute route -----------------------------

await walk("timed out: no Allow on the card; the app's row is the route, and changes the permission only", "screen=card-pending", [
  [link("The deadline passes"), "card-timedout", ["Timed out at 5:44 PM. This iPhone didn't run the request, and Location is still not decided."]],
  [async (p) => check("timed out: the card offers no Allow", (await p.locator("[data-ask-allow]").count()) === 0), null],
  [link("Location in This iPhone"), "phone-on"],
  [async (p) => check("This iPhone lists the timed-out request: didn't run it, sent nothing", (await text(p, '[data-record="t1"]')).includes("Timed out. Didn't run it.") && (await text(p, '[data-record="t1"]')).includes("Sent nothing.")), null],
  [click('[data-allow="location"]'), "phone-on"],
  [async (p) => check("at 61 minutes, Allow on the row: Location Allowed, the request still closed, nothing sent", (await row(p, "location").getAttribute("data-local")) === "allowed" && (await text(p, '[data-record="t1"]')).includes("Didn't run it.") && (await text(p, '[data-record="t1"]')).includes("Sent nothing.")), null],
], phone);
await walk("two requests: two cards; answering one leaves the other waiting", "screen=card-pending&second=1", [
  [async (p) => check("two requests make two cards, each with its own deadline", (await p.locator('.d-ask[data-state="pending"]').count()) === 2 && (await text(p)).includes("5:45:10 PM")), null],
  [click('[data-card="ask"] [data-ask-allow]'), "card-sent"],
  [async (p) => check("the second card still waits after the first is answered", (await p.locator('.d-ask[data-state="pending"]').count()) === 1), null],
], phone);
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
check("stopping below admin: no Also remove it from the gateway", (await p.locator("[data-also-remove]").count()) === 0);
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
p = await open("screen=phone-back", phone);
check("back from the background: records of what was refused and run, and what never arrived", !missing(await text(p), ["Didn't run it: Clawtrate wasn't open.", "NOT_OPEN_ON_DEVICE", "Ran it, before Clawtrate left the foreground.", "never reached it"]));
await p.close();

// 7. A positive read-back for each stage (other devices) -------------------------------------

await walk("another device approved: the confirmation predicts no commands; the read says paired", "screen=machines", [
  [click('[data-request="ipad"] button[data-variant="primary"]'), "machines", ["Approve Kitchen iPad as a device for bots?", "Its commands are a separate request, approved separately."]],
  [click("[data-confirm]"), "machines", ["Kitchen iPad is paired as a device for bots (read 5:22 PM)."]],
]);
await walk("another device's commands approved: the read lists them", "screen=machines", [
  [click('[data-request="pc"] button[data-variant="primary"]'), "machines", ["and run programs and read files on it", "system.run"]],
  [click("[data-confirm]"), "machines", ["The gateway lists these commands for Workshop PC (read 5:22 PM)"]],
]);
await walk("a request that disappears says only that it is no longer pending", "screen=machines", [[link("The request disappears with no event"), "machines", ["The request is no longer pending."]]]);
await walk("a rejection is said from the gateway's report", "screen=machines", [[click('[data-request="ipad"] button[data-variant="quiet"]'), "machines", ["The gateway reported the request rejected."]]]);
p = await open("screen=machines&ipad=approved&readfail=1");
check("a failed read never says approved", (await text(p)).includes("Couldn't read the gateway.") && !(await text(p)).includes("is paired as a device"));
await p.close();
p = await open("screen=machines&access=write");
check("below admin: one line, never a list", (await text(p)).includes("Approving other devices for bots needs admin access.") && (await p.locator(".d-request").count()) === 0);
await p.close();

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
  check("share: back with Otto chosen and the note as edited", (await at(q, "share")) && (await q.inputValue("[data-note]")) === "Edited: take the north trail." && (await text(q)).includes("Send starts a new task with Otto."));
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
p = await open("screen=share-draft&nobot=1", phone);
check("a draft with no bot asks which, and can't be sent until chosen", (await text(p)).includes("This draft has no bot yet.") && (await p.locator(".d-composer button[disabled]").count()) === 1);
await p.close();
p = await open("screen=share", phone);
check("share: a link is text, never a link", (await p.locator('.d-chips a[href^="http"]').count()) === 0);
check("share: the sent words claim acceptance only", !(await (async () => { const q = await open("screen=share-sent", phone); const t = await text(q); await q.close(); return /can read|will read|read the picture/.test(t); })()));
await p.close();

// 9. Siri on a locked phone, and the handoff until the confirmation is proven ----------------

p = await open("screen=siri-locked", phone);
check("locked: asks to unlock and shows no bot name or text", (await text(p)).includes("Unlock your iPhone to use Clawtrate.") && !/Juniper|Marlow|Otto|Pip|water the plants/.test(await text(p, ".d-sys")));
await p.close();
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
check("that request allowed: said in place with what the gateway acknowledged", (await at(p, "mac-request")) && (await text(p)).includes("the gateway accepted the answer. Calendar is allowed from now on."));
await p.close();

// Every state, at desktop and phone width, light and dark ------------------------------------

p = await open("screen=mac-off");
const screens = await p.evaluate(() => window.CT.deviceScreens);
await p.close();
check("the page lists its states", screens.length >= 45, String(screens.length));
const banned = /\b(safe|secure|securely|private|protected|Resumed)\b|your own chat|own chats|Otto wants|Otto asked|was told/i;
for (const [label, width] of [["1440", 1440], ["1100", 1100], ["390", 390]]) {
  const bad = [];
  const words = [];
  const errors = [];
  for (const screen of screens) {
    for (const theme of label === "1100" ? ["light"] : ["light", "dark"]) {
      const q = await open(`screen=${screen}${label === "390" ? "&width=phone" : "&width=full"}`, { width, height: 844, theme });
      if (!(await q.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1))) bad.push(`${screen}/${theme}`);
      if (theme === "light" && banned.test(await text(q))) words.push(screen);
      if (q.errors.length) errors.push(`${screen}: ${q.errors[0]}`);
      if (theme === "dark" && !(await q.evaluate(() => document.documentElement.dataset.theme === "dark"))) errors.push(`${screen}: not dark`);
      await q.close();
    }
  }
  check(`every state at ${label}: no sideways scroll`, bad.length === 0, bad.join(" "));
  check(`every state at ${label}: no page errors`, errors.length === 0, errors.join(" | "));
  check(`every state at ${label}: none of the words the design rules out`, words.length === 0, words.join(" "));
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
