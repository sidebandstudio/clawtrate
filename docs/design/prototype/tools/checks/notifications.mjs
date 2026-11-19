// Checks for notifications.html: docs/design/notifications.md. Each event, for
// each device, to its picture or to the reason nothing was shown; each click to
// what it opens, and each check that can fail at a click; quiet hours, focus and
// the switches; Settings, the bot's page and the task's setting, with saving,
// read-back, failure, conflict and the read-only connection; widths, keyboard
// and themes.
// Run from the repository root:  node docs/design/prototype/tools/checks/notifications.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("notifications.html") + "?page=notifications";
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
  await p.goto(`${base}&theme=${theme}${query.includes("chrome=1") ? "" : "&chrome=0"}&${query}`);
  await p.waitForTimeout(120);
  p.errors = errors;
  return p;
};
const text = (p, sel = "#root") => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
const missing = (t, words) => words.filter((w) => !t.includes(w)).join(" | ");
const click = async (p, selector) => {
  await p.locator(selector).first().click();
  await p.waitForTimeout(80);
};
const pics = (p) => p.$$eval('[data-testid="n-pic"]', (els) => els.map((e) => e.textContent.replace(/\s+/g, " ").trim()));
const why = (p) => text(p, '[data-testid="n-why"]');
const focusedId = (p) => p.evaluate(() => document.activeElement?.id || document.activeElement?.closest("[id]")?.id || "");

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Part 1: each event, for each device, to its picture or the reason --------------------------------

async function shown(name, query, words, { not = [] } = {}) {
  const p = await open(query);
  const list = await pics(p);
  const all = list.join(" ");
  const label = list.every((t) => t.startsWith("Picture of a system notification"));
  const leaks = not.filter((w) => all.includes(w));
  check(`shown: ${name}`, list.length === 1 && !missing(all, words) && label && !leaks.length && !p.errors.length, `${JSON.stringify(list)} missing: ${missing(all, words)} leaks: ${leaks} ${p.errors}`);
  await p.close();
}
async function notShown(name, query, words) {
  const p = await open(query);
  const list = await pics(p);
  const w = await why(p);
  check(`not shown: ${name}`, list.length === 0 && !missing(w, words) && !p.errors.length, `${JSON.stringify(list)} why: ${w} ${p.errors}`);
  await p.close();
}

const PRIVATE = ["du -sh", "3:25 AM", "Weekly backup check", "Disk almost full", "running cost", "Router firmware"];
await shown("a reply, on the device that sent the message", "event=finished", ["Otto", "Finished."], { not: PRIVATE });
await shown("a reply, on another device", "event=finished&device=other", ["Otto", "Finished."], { not: PRIVATE });
await shown("a reply, on a read-only device", "event=finished&device=read", ["Otto", "Finished."], { not: PRIVATE });
await shown("a reply with previews: the task's title and the reply's first words", "event=finished&previews=1", ["Otto", "Finished.", "Weekly backup check: Yes. Last night's backup finished at 3:25 AM"]);
await shown("a failure", "event=failed", ["Otto", "Its run failed."], { not: PRIVATE });
await shown("a failure with previews: the task's title, never the error's words", "event=failed&previews=1", ["Its run failed.", "Router firmware"], { not: ["model request"] });
await notShown("a stop", "event=stopped", ["A stopped run isn't notified: someone chose to stop it."]);
await shown("an approval on the device that sent the message: its kind", "event=approval", ["Otto", "Wants to run a command."], { not: PRIVATE });
await shown("an approval with previews: the command", "event=approval&previews=1", ["Wants to run a command.", "Disk almost full on the media box: du -sh /var/lib/transcode-cache"]);
await shown("an approval another device sent: only that it waits", "event=approval&device=other", ["Otto", "Is waiting for an approval. It can be answered on the device that sent the message."], { not: ["Wants to run a command", ...PRIVATE] });
await shown("an approval on a read-only device", "event=approval&device=read", ["Otto", "Is waiting for an approval. This device can only read."], { not: PRIVATE });
await shown("a question on the device that sent the message", "event=question", ["Juniper", "Asked you a question."], { not: ["running cost", "Heat pump"] });
await shown("a question on another interactive device", "event=question&device=other", ["Juniper", "Asked you a question."]);
await notShown("a question on a read-only device", "event=question&device=read", ["A read-only device receives nothing that says a question waits."]);
await shown("a question in another bot's task names that bot", "event=marlow", ["Marlow", "Asked you a question."]);
await shown("a budget warning", "event=budget", ["Otto", "Used 82% of its weekly budget. Shown only: nothing was stopped."]);
await notShown("a budget warning with Budget warnings off", "event=budget&budgetsw=0", ["Budget warnings are off on this computer."]);
await shown("a budget warning while the bot is off: it has its own switch", "event=budget&bot=otto=off", ["Used 82%"]);
await notShown("anything with Show notifications off", "event=approval&master=0", ["Show notifications is off on this computer."]);
await notShown("a bot switched off", "event=finished&bot=otto=off", ["Notifications for Otto are off."]);
await shown("a task On while its bot is off", "event=finished&bot=otto=off&task=on", ["Otto", "Finished."]);
await notShown("a task Off while its bot is on", "event=finished&task=off", ["This task's notifications are off."]);
await notShown("the bot on screen in a focused window", "event=finished&focus=otto", ["Otto is on screen in the focused window."]);
await shown("another bot while the window is focused on Otto", "event=question&focus=otto", ["Juniper", "Asked you a question."]);
await shown("Pip on screen does not silence Otto", "event=approval&focus=pip", ["Otto", "Wants to run a command."]);
await notShown("Linux: nothing while the window is focused", "event=question&focus=otto&os=linux", ["On Linux nothing is shown then."]);
await shown("Linux: shown while the window is not focused", "event=question&os=linux", ["Juniper"]);
await notShown("a build that can't show notifications", "event=approval&platform=none", ["This copy of Clawtrate can't show notifications here. The rail and the badge show it."]);
await notShown("before your settings are read", "event=finished&prefs=reading", ["Your settings haven't been read from the gateway"]);
await notShown("a reply during quiet hours: never shown later", "event=finished&quiet=1", ["Quiet hours: this is never shown later."]);
await notShown("a wait during quiet hours is held", "event=approval&quiet=1", ["Held until 07:00: Otto is waiting for you."]);

// Quiet hours end: a held wait still waiting is shown; one answered meanwhile is not.
let p = await open("event=approval&quiet=1");
check("quiet hours: the rail still shows the wait", (await text(p, ".bot-list")).includes("Waiting for you: approve a command"));
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
check("quiet hours end: the held wait is shown then", (await pics(p)).join(" ").includes("Wants to run a command."), JSON.stringify(await pics(p)));
await p.close();
p = await open("event=approval&quiet=1&chrome=1");
await click(p, '[data-bar="answered"]');
await click(p, '[data-bar="quietend"]');
check("quiet hours end: a wait answered on another device is not shown", (await pics(p)).length === 0 && (await why(p)).includes("Nothing still waiting"), await why(p));
await p.close();
p = await open("event=finished&quiet=1");
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
check("quiet hours end: a reply from during them is not shown later", (await pics(p)).length === 0);
await p.close();

// A budget warning in quiet hours: held, shown at the end if it still holds; nothing if it lapsed.
await notShown("a budget warning during quiet hours is held", "event=budget&quiet=1", ["Held until 07:00: Otto's budget warning, shown then if the budget is still at or over 80% for this period."]);
p = await open("event=budget&quiet=1");
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
check("quiet hours end: a held budget warning still at 80% is shown, once", (await pics(p)).length === 1 && (await pics(p))[0].includes("Used 82% of its weekly budget."), JSON.stringify(await pics(p)));
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
check("quiet hours end: it is not shown a second time", (await pics(p)).length === 1);
await p.close();
p = await open("event=budget&quiet=1&chrome=1");
await click(p, '[data-bar="lapsed"]');
await click(p, '[data-bar="quietend"]');
check("quiet hours end: a budget raised or a period rolled over meanwhile shows nothing", (await pics(p)).length === 0 && (await why(p)).includes("Nothing still waiting"), await why(p));
await p.close();

// One per task: a newer event for the task replaces the picture shown.
p = await open("event=approval");
await p.evaluate(() => window.notif.fire("budget"));
await p.waitForTimeout(60);
check("one per task: a newer event replaces the one shown", (await pics(p)).length === 1 && (await pics(p))[0].includes("Used 82%"), JSON.stringify(await pics(p)));
await p.evaluate(() => window.notif.fire("question"));
await p.waitForTimeout(60);
check("several bots: each gets its own", (await pics(p)).length === 2);
await p.close();

// The bar fires events by clicking.
p = await open("chrome=1");
await p.selectOption('[data-bar="event"]', "question");
await click(p, '[data-bar="fire"]');
check("the bar: Happens fires the chosen event", (await pics(p)).join(" ").includes("Asked you a question."));
await p.selectOption('[data-bar="device"]', "read");
await p.selectOption('[data-bar="event"]', "approval");
await click(p, '[data-bar="fire"]');
check("the bar: a read-only device's approval words", (await pics(p)).join(" ").includes("This device can only read."));
await p.close();

// Part 2: what a click opens ---------------------------------------------------------------------------

async function opens(name, query, expect) {
  const p = await open(query);
  await click(p, "[data-n-open]");
  await p.waitForTimeout(150);
  const t = await text(p, "#transcript");
  const pill = await text(p, "#title-pill");
  const focus = await focusedId(p);
  const left = (await pics(p)).length;
  const ok = !missing(t, expect.words) && (!expect.pill || pill.includes(expect.pill)) && (!expect.focus || focus === expect.focus) && left === 0 && !(expect.not || []).some((w) => t.includes(w));
  check(`opens: ${name}`, ok && !p.errors.length, `pill: ${pill} focus: ${focus} pics left: ${left} missing: ${missing(t, expect.words)} ${p.errors}`);
  await p.close();
}
await opens("a reply: the task, at the reply, focused", "event=finished", { pill: "Weekly backup check", words: ["Yes. Last night's backup finished at 3:25 AM"], focus: "n-target" });
await opens("a failure: the task, at the turn error", "event=failed", { pill: "Router firmware", words: ["Otto couldn't finish this turn"], focus: "n-target" });
await opens("an approval it received: the card, focused", "event=approval", { pill: "Disk almost full on the media box", words: ["Otto wants to run a command", "Needs approval", "Allow once", "Deny"], focus: "n-target" });
await opens("a wait it only saw: the task with the note, no answer offered", "event=approval&device=other", { words: ["Otto is waiting for an approval. This device can't answer it: the device that sent the message can."], focus: "n-target", not: ["Allow once", "Deny"] });
await opens("a wait on a read-only device: conversation.md §3's note", "event=approval&device=read", { words: ["This device can't see it on a read-only connection.", "Request access"], focus: "n-target", not: ["Allow once"] });
await opens("a question: the card, focused", "event=question", { pill: "Heat pump vs. gas furnace", words: ["Which matters more to you: running cost or upfront price?"], focus: "n-target" });
await opens("a question in another bot's task: that bot and task", "event=marlow", { pill: "Notes for Pip", words: ["Marlow is working on a message from Pip.", "Should the plan keep Saturday morning free?"], focus: "n-target" });
await opens("a budget warning: the bot's open task, at the line", "event=budget", { pill: "Disk almost full", words: ["Otto has used 82% of its weekly budget: 1.64M of 2M tokens."], focus: "n-target" });

p = await open("event=marlow");
await click(p, "[data-n-open]");
check("another bot's task: the rail selects and unfolds that bot", await p.evaluate(() => document.querySelector('.bot-group[data-open="true"] .bot')?.dataset.bot === "marlow" && document.querySelector('.task[aria-current="true"]')?.dataset.task === "m1"));
await p.close();

async function clickFails(name, query, expect) {
  const p = await open(query);
  await click(p, "[data-n-open]");
  await p.waitForTimeout(150);
  const strip = await text(p, "#status-strip");
  const t = await text(p, "#transcript");
  const w = await why(p);
  const ok = (!expect.strip || strip.includes(expect.strip)) && (!expect.why || w.includes(expect.why)) && !(expect.not || []).some((x) => t.includes(x)) && !missing(t, expect.words || []);
  check(`at the click: ${name}`, ok && !p.errors.length, `strip: ${strip} why: ${w} transcript: ${t.slice(0, 160)}`);
  await p.close();
}
await clickFails("a task that is gone opens its bot's list and says so; nothing is sent", "event=finished&click=gone", { strip: "That task is no longer on the gateway.", words: ["Pick a task"], not: ["3:25 AM"] });
await clickFails("the connection is down: the task opens from what was loaded", "event=approval&click=offline", { strip: "Reconnecting in 4s", words: ["Otto wants to run a command"] });
await clickFails("another gateway: nothing opens", "event=approval&click=othergw", { strip: "That notification came from Studio gateway. Clawtrate is using Home gateway now.", not: ["Otto wants to run a command"] });
await clickFails("no record: Clawtrate comes forward and opens nothing", "event=approval&click=stale", { why: "It has no record of that notification, so nothing opened.", not: ["Otto wants to run a command"] });
p = await open("event=approval&click=othergw");
await click(p, "[data-n-open]");
check("another gateway: the strip offers Your gateways", (await text(p, "#status-strip")).includes("Your gateways"));
await click(p, '#status-strip [data-n="gateways"]');
check("Your gateways opens that Settings section", (await text(p, "#b-section-title")) === "Your gateways");
await p.close();
p = await open("event=finished&click=gone");
await click(p, "[data-n-open]");
check("a task that is gone: no composer and no task is selected", await p.evaluate(() => !document.querySelector(".composer-input") && !document.querySelector('.task[aria-current="true"]')));
check("a task that is gone: the rail no longer lists it", !(await text(p, ".bot-list")).includes("Weekly backup check"));
await p.close();

p = await open("event=finished");
await click(p, '.task[data-task="o3"]');
check("opening the task in Clawtrate withdraws its notification", (await pics(p)).length === 0);
await p.close();

// Part 3: Settings, Notifications ------------------------------------------------------------------------

p = await open("open=settings");
let s = await text(p, "#settings-dialog");
check(
  "Settings: the section's rows and words",
  !missing(s, [
    "Notifications",
    "This computer",
    "Show notifications",
    "When a bot finishes or waits for you.",
    "Show previews",
    "Anyone who can see your screen can read them, also when it's locked, unless your system hides previews.",
    "Budget warnings",
    "When a bot has used 80% of a budget.",
    "It can't see whether macOS allows them or whether a Focus is on.",
    "Quiet hours",
    "Nothing is shown during them. A bot still waiting for you when they end is shown then.",
    "Your bots",
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]),
  missing(s, ["Show previews"]),
);
check(
  "Settings: each group says where it is kept",
  (await text(p, '[data-testid="kept-device"]')) === "Kept on this computer." &&
    (await text(p, '[data-testid="kept-quiet"]')) === "Kept for you on this gateway, so your other devices show the same." &&
    (await text(p, '[data-testid="kept-bots"]')) === "Kept for you on this gateway, so your other devices show the same.",
);
check("Settings: the section sits after Appearance and before System", await p.evaluate(() => [...document.querySelectorAll("[data-n-section]")].map((x) => x.textContent.trim()).join(",").includes("Appearance,Notifications,System")));
check("Settings: previews are off and the others on by default", await p.evaluate(() => ["master", "budgetsw"].every((k) => document.querySelector(`[data-n-set="${k}"]`).getAttribute("aria-checked") === "true") && document.querySelector('[data-n-set="previews"]').getAttribute("aria-checked") === "false"));
check("Settings: Otto's line counts a task with its own setting", s.includes("On · 1 task off"));
check("Settings: every switch has role switch and a name", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-switch")].every((x) => x.getAttribute("role") === "switch" && x.getAttribute("aria-label"))));
check("Settings: the title takes focus", (await focusedId(p)) === "b-section-title");
await click(p, '[data-n-bot="otto"]');
check("saving: the switch is disabled and says Saving…", (await text(p, '[data-row="bot-otto"]')).includes("Saving…") && (await p.isDisabled('[data-n-bot="otto"]')));
await p.waitForTimeout(650);
check("saved: the switch shows what was read back", (await p.getAttribute('[data-n-bot="otto"]', "aria-checked")) === "false");
check("saved: announced only once read back", (await text(p, "#settings-live")) === "Otto's notifications are off");
await click(p, '[data-n-set="previews"]');
await p.waitForTimeout(450);
check("this computer's switch: saved and announced", (await p.getAttribute('[data-n-set="previews"]', "aria-checked")) === "true" && (await text(p, "#settings-live")) === "Previews are shown");
await click(p, '[data-n-set="master"]');
await p.waitForTimeout(450);
check("Show notifications off: the line says what that means", (await text(p, '[data-row="master"]')).includes("No notifications on this computer. Your other devices keep theirs."));
await click(p, '[data-n-set="quiet"]');
await p.waitForTimeout(650);
s = await text(p, "#settings-dialog");
check("quiet hours on: the times and the zone line", !missing(s, ["From", "To", "22:00 to 07:00, Lisbon time. Set on this computer."]) && (await text(p, "#settings-live")) === "Quiet hours are on, 22:00 to 07:00", missing(s, ["From"]));
await p.fill('[data-n-time="to"]', "22:00");
await p.waitForTimeout(80);
check("quiet hours: the same start and end is refused, nothing saved", (await text(p, '[data-testid="time-error"]')) === "Start and end can't be the same time." && (await p.evaluate(() => window.notif.S.quiet.to)) === "07:00");
await p.fill('[data-n-time="to"]', "06:30");
await p.waitForTimeout(650);
check("quiet hours: a new end is saved and read back", (await text(p, '[data-testid="zone-line"]')).includes("22:00 to 06:30") && !(await p.$('[data-testid="time-error"]')));
await p.keyboard.press("Escape");
await p.waitForTimeout(80);
check("Escape closes Settings", !(await p.evaluate(() => document.querySelector("#settings-dialog").open)));
await p.close();

for (const [os, words] of [
  ["windows", "Closing its window quits it. It can't see whether Windows allows them or whether Do Not Disturb is on."],
  ["linux", "Clawtrate shows notifications while it's open, and none while its window is focused."],
]) {
  p = await open(`open=settings&os=${os}`);
  check(`Settings on ${os}: the system's note`, (await text(p, '[data-testid="system-note"]')).includes(words));
  await p.close();
}

async function settingsState(name, query, words, test) {
  const p = await open(`open=settings&${query}`);
  const s = await text(p, "#settings-dialog");
  const extra = test ? await p.evaluate(test) : true;
  check(`Settings, ${name}`, !missing(s, words) && extra && !p.errors.length, `missing: ${missing(s, words)} extra: ${extra}`);
  await p.close();
}
await settingsState("reading", "prefs=reading", ["Reading your settings from the gateway…"], () => !document.querySelector("[data-n-bot]") && Boolean(document.querySelector('[aria-busy="true"]')));
await settingsState("couldn't read", "prefs=readfail", ["Couldn't read your notification settings from the gateway. Until Clawtrate can, it shows no notifications about your bots.", "Try again"]);
await settingsState("kept on this computer when the gateway keeps no profile", "prefs=device", ["Kept on this computer: this connection has no profile on the gateway to keep it in, so your other devices won't show it."], () => document.querySelectorAll('#settings-dialog [data-testid^="kept-"]').length === 3);
await settingsState(
  "a build that can't show notifications, macOS: no switch promises one",
  "platform=none",
  ["This copy of Clawtrate can't show notifications on macOS. What your bots finish or wait on shows in the rail and on the dock's badge.", "Quiet hours and your bots' switches below apply on your other devices.", "Kept for you on this gateway, so your other devices show the same."],
  () => !document.querySelector('[data-n-set="master"], [data-n-set="previews"], [data-n-set="budgetsw"], [data-testid="system-note"]'),
);
await settingsState("a build that can't show notifications, Windows", "platform=none&os=windows", ["can't show notifications on Windows.", "in the rail and on the taskbar button."]);
await settingsState("set on a device in another zone", "prefs=elsewhere&quietset=1", ["22:00 to 07:00, Lisbon time, where they were set. That's 23:00 to 08:00 here. Saving here sets them in Berlin time."]);
await settingsState("the system refused one", "failed=1", ["Your system didn't show Clawtrate's notification at 5:41 PM. Check Clawtrate in your system's notification settings."]);
await settingsState(
  "read-only: values shown, your settings disabled, this computer's not",
  "access=read",
  ["Read-only.", "Changing quiet hours and your bots' notifications needs more access.", "Request access"],
  () => [...document.querySelectorAll("[data-n-bot], [data-n-set='quiet']")].every((x) => x.disabled) && !document.querySelector('[data-n-set="master"]').disabled,
);
await settingsState("quiet now, with a wait held", "quiet=1&event=approval", ["Quiet until 07:00. 1 bot is waiting for you. It will be shown then."]);

p = await open("open=settings&prefs=readfail");
await click(p, '[data-n="retry-read"]');
check("couldn't read: Try again reads and shows the settings", (await text(p, "#settings-dialog")).includes("Your bots"));
await p.close();
p = await open("open=settings&access=read");
await click(p, '#settings-dialog [data-n="request"]');
check("read-only: Request access shows the request waiting for the owner", (await text(p, "#settings-dialog")).includes("Waiting for the gateway's owner."));
await p.close();
p = await open("open=settings&prefs=savefail");
await click(p, '[data-n-bot="otto"]');
await p.waitForTimeout(650);
check("couldn't save: the switch stays and says so", (await p.getAttribute('[data-n-bot="otto"]', "aria-checked")) === "true" && (await text(p, '[data-row="bot-otto"]')).includes("Couldn't save. Otto's notifications are still on."));
await p.close();
p = await open("open=settings&prefs=conflict");
await click(p, '[data-n-bot="otto"]');
await p.waitForTimeout(650);
check("changed elsewhere: the note, and what was read again", (await text(p, "#settings-dialog")).includes("Changed on another of your devices a moment ago. This is what's set now.") && (await p.getAttribute('[data-n-bot="pip"]', "aria-checked")) === "false");
await p.close();

// Part 4: the bot's row and page (bots.md §8) ---------------------------------------------------------------

p = await open("chrome=1");
await click(p, '[data-n="panel"]');
await click(p, '[data-tab="settings"]');
s = await text(p, "#panel-settings");
check("the bot's settings: one Notifications row, in its own group after Tools", !missing(s, ["Tools", "Notifications", "On", "Runs on"]) && s.indexOf("Permissions") < s.indexOf("Notifications") && s.indexOf("Notifications") < s.indexOf("Runs on"));
await click(p, '[data-testid="bot-notifications-row"]');
s = await text(p, "#panel-settings");
check("the bot's page: its switch and its tasks with their own setting", !missing(s, ["Notifications", "Notify me about Otto", "When Otto finishes or waits for you.", "Tasks with their own setting", "Certificate renewal warning", "Off"]), s);
check("the bot's page: the switch says where it is kept", (await text(p, '[data-testid="kept-bot"]')) === "Kept for you on this gateway, so your other devices show the same.");
check("the bot's page: the title takes focus", await p.evaluate(() => document.activeElement?.matches("[data-n-focus]")));
await click(p, '[data-n-bot="otto"]');
await p.waitForTimeout(650);
check("the bot's page: the switch saves and reads back", (await p.getAttribute('#panel-settings [data-n-bot="otto"]', "aria-checked")) === "false" && (await text(p, "#pane-live")) === "Otto's notifications are off");
await click(p, '[data-n="bot-back"]');
check("Back: the row shows Off, with focus on it", (await text(p, '[data-testid="bot-notifications-row"]')).includes("Off") && (await p.evaluate(() => document.activeElement?.dataset.n === "bot-page")));
await p.close();
p = await open("open=bot&master=0&quiet=1");
s = await text(p, "#panel-settings");
check("the bot's page: notes for this computer's switch and quiet hours", !missing(s, ["Notifications are off on this computer.", "Settings", "Quiet until 07:00."]));
await p.close();
p = await open("open=bot&access=read");
check("the bot's page, read-only: the switch disabled and the access bar", (await p.isDisabled('#panel-settings [data-n-bot="otto"]')) && (await text(p, "#panel-settings")).includes("Request access"));
await p.close();
p = await open("open=bot&platform=none");
check("a build that can't show notifications: the bot's page says so", (await text(p, "#panel-settings")).includes("This copy of Clawtrate can't show notifications. This switch applies on your other devices."));
await p.close();
p = await open("open=details&platform=none");
check("a build that can't show notifications: the task's setting says so", (await text(p, "#panel-details")).includes("This copy of Clawtrate can't show notifications. This setting applies on your other devices."));
await p.close();
p = await open("platform=none&chrome=1");
await click(p, '[data-n="panel"]');
await click(p, '[data-tab="settings"]');
check("a build that can't show notifications: the row reads Not shown on this computer", (await text(p, '[data-testid="bot-notifications-row"]')).includes("Not shown on this computer"));
await p.close();
p = await open("master=0&chrome=1");
await click(p, '[data-n="panel"]');
await click(p, '[data-tab="settings"]');
check("the row reads Off on this computer when Show notifications is off", (await text(p, '[data-testid="bot-notifications-row"]')).includes("Off on this computer"));
await p.close();

// Part 5: the task's setting ---------------------------------------------------------------------------------

p = await open("open=details");
s = await text(p, '[data-testid="task-setting"]');
check("Details: This task, Same as Otto (on)", s.includes("This task") && s.includes("Same as Otto (on)"), s);
check("Details: the setting says where it is kept", (await text(p, '[data-testid="kept-task"]')) === "Kept for you on this gateway, so your other devices show the same.");
await click(p, '[data-n="task-menu"]');
const items = await p.$$eval("[data-n-task]", (els) => els.map((e) => e.textContent.trim()));
check("the menu: three radio items, the current one checked", items.join("|") === "Same as Otto (on)|On|Off" && (await p.getAttribute('[data-n-task="same"]', "aria-checked")) === "true", items.join("|"));
check("the menu: focus on the current item", await p.evaluate(() => document.activeElement?.dataset.nTask === "same"));
await p.keyboard.press("ArrowDown");
await p.keyboard.press("ArrowDown");
check("the menu: arrows move", await p.evaluate(() => document.activeElement?.dataset.nTask === "off"));
await p.keyboard.press("Escape");
check("the menu: Escape closes it and returns focus", (await p.isHidden("#n-menu")) && (await p.evaluate(() => document.activeElement?.dataset.n === "task-menu")));
await click(p, '[data-n="task-menu"]');
await click(p, '[data-n-task="off"]');
check("choosing: Saving…", (await text(p, '[data-testid="task-setting"]')).includes("Saving…"));
await p.waitForTimeout(650);
check("chosen: Off, read back and announced", (await text(p, '[data-testid="task-setting"]')).includes("Off") && (await text(p, "#pane-live")) === "This task: Off");
await p.close();
p = await open("open=details&tasks=full");
await click(p, '[data-n="task-menu"]');
await click(p, '[data-n-task="on"]');
check("41st task: the bound, nothing saved", (await text(p, '[data-testid="task-limit"]')).includes('Up to 40 tasks can have their own setting. Set one back to "Same as" its bot first.') && (await p.evaluate(() => !window.notif.S.tasks.o3)));
await p.close();
p = await open("open=details&access=read");
check("Details, read-only: the select disabled and the access bar", (await p.isDisabled('[data-n="task-menu"]')) && (await text(p, "#panel-details")).includes("Request access"));
await p.close();
p = await open("open=details&prefs=savefail");
await click(p, '[data-n="task-menu"]');
await click(p, '[data-n-task="on"]');
await p.waitForTimeout(650);
check("Details: couldn't save keeps the value and says so", (await text(p, '[data-testid="task-error"]')).includes("Couldn't save. This task is still Same as Otto (on).") && (await text(p, '[data-testid="task-setting"]')).includes("Same as Otto (on)"));
await p.close();

// Part 6: widths, themes, keyboard --------------------------------------------------------------------------

for (const width of [1100, 800, 390]) {
  for (const query of ["event=approval", "open=settings", "open=details"]) {
    p = await open(query, { width, height: 844 });
    const wide = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    check(`no sideways scroll at ${width}: ${query}`, !wide && !p.errors.length);
    await p.close();
  }
}
p = await open("open=settings", { width: 390, height: 844 });
check("phone: Settings shows the section with Back to the list", await p.evaluate(() => getComputedStyle(document.querySelector('[data-n="to-nav"]')).display !== "none" && getComputedStyle(document.querySelector(".b-nav")).display === "none"));
await click(p, '[data-n="to-nav"]');
check("phone: Back shows the list, with focus on Notifications", await p.evaluate(() => getComputedStyle(document.querySelector(".b-nav")).display !== "none" && document.activeElement?.dataset.nSection === "notifications"));
await p.close();
p = await open("event=approval", { width: 390, height: 844 });
check("phone: the picture spans the width less the gutters", await p.evaluate(() => {
  const r = document.querySelector('[data-testid="n-pic"]').getBoundingClientRect();
  return r.left >= 15 && innerWidth - r.right >= 15;
}));
await p.close();
p = await open("event=approval", { theme: "dark" });
check("dark: the picture uses the product's tokens", await p.evaluate(() => {
  const bg = getComputedStyle(document.querySelector(".n-pic")).backgroundColor;
  return document.documentElement.dataset.theme === "dark" && bg !== "rgb(255, 255, 255)";
}));
await p.close();
p = await open("event=approval&motion=reduce&open=settings");
check("reduced motion: the switch thumb does not slide", await p.evaluate(() => getComputedStyle(document.querySelector(".b-switch"), "::after").transitionDuration.split(",").every((d) => parseFloat(d) === 0)));
await p.close();
p = await open("");
await p.keyboard.press("Meta+,");
await p.waitForTimeout(80);
check("⌘, opens Settings at Notifications", (await p.evaluate(() => document.querySelector("#settings-dialog").open)) && (await text(p, "#b-section-title")) === "Notifications");
await p.close();

// Part 7: the gallery reaches this page -----------------------------------------------------------------------

p = await b.newPage();
await p.goto(pageUrl("gallery.html") + "?chrome=1");
await p.waitForTimeout(100);
check("gallery: links to the notifications page", await p.evaluate(() => [...document.querySelectorAll("a")].some((a) => a.getAttribute("href")?.startsWith("notifications.html"))));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} ok, ${failed} failed`);
process.exit(failed ? 1 : 0);
