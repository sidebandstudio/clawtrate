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

const PRIVATE = ["du -sh", "3:25 AM", "Weekly backup check", "Disk almost full", "running cost", "Router firmware", "Heat pump", "Notes for Pip", "notes plugin", "supplier"];
// Ruling 1: no gateway text ever, a fixed sentence for the kind; the bot's name, or "Clawtrate".
await shown("a reply, on the device that sent the message", "event=finished", ["Otto", "Finished."], { not: PRIVATE });
await shown("a reply, on another device", "event=finished&device=other", ["Otto", "Finished."], { not: PRIVATE });
await shown("a reply, on a read-only device", "event=finished&device=read", ["Otto", "Finished."], { not: PRIVATE });
await shown("a reply with bot names off: Clawtrate and a fixed sentence", "event=finished&names=0", ["Clawtrate", "A bot finished."], { not: [...PRIVATE, "Otto"] });
await shown("a failure", "event=failed", ["Otto", "Its run failed."], { not: [...PRIVATE, "model request"] });
await shown("a failure with bot names off", "event=failed&names=0", ["A bot's run failed."], { not: ["Otto"] });
await notShown("a stop", "event=stopped", ["A stopped run isn't notified: someone chose to stop it."]);
await notShown("a run that ended without a visible reply", "event=yielded", ["A run that ended without a visible reply isn't notified."]);
await shown("an approval on the device that sent the message: its kind, never the command", "event=approval", ["Otto", "Wants to run a command."], { not: PRIVATE });
await shown("an approval with bot names off", "event=approval&names=0", ["Clawtrate", "A bot wants to run a command."], { not: [...PRIVATE, "Otto"] });
await shown("an approval on an admin or reviewer device: the card's kind", "event=approval&device=admin", ["Otto", "Wants to run a command."], { not: PRIVATE });
await shown("a plugin's approval: a fixed sentence, never its title", "event=generic", ["Otto", "Needs your approval."], { not: PRIVATE });
await shown("an approval another device sent: this device doesn't have it", "event=approval&device=other", ["Otto", "A run is waiting for approval. This device doesn't have the approval request."], { not: ["Wants to run a command", ...PRIVATE] });
await shown("an approval on a read-only device", "event=approval&device=read", ["Otto", "A run is waiting for approval. This device doesn't have the approval request."], { not: PRIVATE });
await shown("a question on the device that sent the message", "event=question", ["Juniper", "Asked you a question."], { not: PRIVATE });
await shown("a question on another interactive device", "event=question&device=other", ["Juniper", "Asked you a question."], { not: PRIVATE });
await shown("a question this app can't answer", "event=unsupported", ["Juniper", "Asked something this app can't answer yet."], { not: PRIVATE });
await notShown("a question on a read-only device", "event=question&device=read", ["A read-only device receives nothing that says a question waits."]);
await shown("a question in another bot's task names that bot", "event=marlow", ["Marlow", "Asked you a question."], { not: PRIVATE });
await shown("a routine that failed in an ordinary task", "event=routinetask", ["Otto", "Its run failed."]);
await notShown("an isolated routine", "event=routineisolated", ["Isolated routines and cron completion events do not notify here."]);
await shown("a budget warning", "event=budget", ["Otto", "Reached 80% of its budget. Shown only: nothing was stopped."], { not: ["82%", "tokens"] });
await notShown("a budget warning with Budget warnings off", "event=budget&budgetsw=0", ["Budget warnings are off on this computer."]);
await shown("a budget warning while the bot is off: it has its own switch", "event=budget&bot=otto=off", ["Reached 80% of its budget."]);
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
await notShown("before your settings are read", "event=finished&prefs=reading", ["Your settings aren't confirmed from the gateway"]);
await notShown("an event while the connection is down", "event=finished&conn=down", ["The connection is down: this device receives nothing until it reconnects."]);
await notShown("a reply during quiet hours: never shown later", "event=finished&quiet=1", ["Quiet hours: this is never shown later."]);
await notShown("a wait with a card during quiet hours is held", "event=approval&quiet=1", ["Held until 07:00, Lisbon time: Otto is waiting for you."]);
await notShown("a wait this device has no request for is not held", "event=approval&quiet=1&device=other", ["a wait this device has no request for isn't held. It can't be confirmed later."]);

let p = await open("event=finished");
check("ruling 1: the native id and group are opaque, never a task key", await p.evaluate(() => { const el = document.querySelector('[data-testid="n-pic"]'); return /^n\d+$/.test(el.dataset.nativeId) && /^g\d+$/.test(el.dataset.nativeGroup); }));
check(
  "fix 1: the bootstrap token, device token, trimmed sign-in value and derived form are gone before the cut",
  await p.evaluate(() => {
    const t = window.notif.nativeTitle("Ops boot-sample-token-0000 dev-sample-token-1111 signin-sample-key-2222 code-sample-3333");
    return t === "Ops … … … …" && !/sample/.test(t);
  }),
);
check("fix 1: the scrub runs before the 40-code-point cut", await p.evaluate(() => { const t = window.notif.nativeTitle(`${"B".repeat(30)} code-sample-3333 ${"C".repeat(20)}`); return !t.includes("code-sample") && [...t].length === 40; }));
check("ruling 1: the title is cut to 40 characters", await p.evaluate(() => { const t = window.notif.nativeTitle("A".repeat(60)); return [...t].length === 40 && t.endsWith("…"); }));
await p.evaluate(() => window.notif.fire("finished"));
await p.waitForTimeout(60);
check("ruling 4: one finished notification per run", (await pics(p)).length === 1 && (await why(p)).includes("This run was already notified."));
await p.close();

// Quiet hours end: a held wait with a fresh pending record is shown; one answered meanwhile is not.
p = await open("event=approval&quiet=1");
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
p = await open("event=approval&quiet=1&chrome=1");
await click(p, '[data-bar="drop"]');
await click(p, '[data-bar="quietend"]');
check("ruling 2: quiet hours that end offline drop the hold", (await pics(p)).length === 0 && (await why(p)).includes("Quiet hours ended while the connection was down. The holds were dropped"), await why(p));
await p.close();
p = await open("event=approval&quiet=1&chrome=1");
await click(p, '[data-bar="wake"]');
check("ruling 6: waking after the end replays nothing", (await pics(p)).length === 0 && (await why(p)).includes("Nothing from while it slept is replayed"), await why(p));
await p.close();

// Ruling 2: a disconnect clears phase-only waits; a reconnect posts no catch-up notification.
p = await open("event=approval&device=other&chrome=1");
check("ruling 2: a phase-only wait is shown while connected", (await pics(p)).length === 1);
await click(p, '[data-bar="drop"]');
check("ruling 2: a disconnect withdraws it and clears its mark", (await pics(p)).length === 0 && !(await text(p, ".bot-list")).includes("Waiting for an approval"));
await click(p, '[data-bar="reconnect"]');
check("ruling 2: a reconnect posts nothing", (await pics(p)).length === 0 && (await why(p)).includes("Reconnected. Missed events can appear in your tasks; no notification is posted for them."), await why(p));
await p.close();
p = await open("event=approval&chrome=1");
await click(p, '[data-bar="drop"]');
check("ruling 2: a card this device has stays shown through a disconnect", (await pics(p)).length === 1);
await p.close();

// Ruling 5: a held budget warning, released only with a fresh figure for the same budget and period.
await notShown("a budget warning during quiet hours is held", "event=budget&quiet=1", ["Held until 07:00, Lisbon time: Otto's budget warning. It needs a fresh figure for this period then."]);
for (const [end, show, words] of [
  ["still", true, ""],
  ["raised", true, ""],
  ["over100", true, ""],
  ["below", false, "the count is under 80% of the confirmed limit"],
  ["refreshing", false, "the gateway was still counting, so the figure is unknown"],
  ["readfail", false, "the count has an error, though it kept the earlier figure"],
  ["prefsfail", false, "the budgets preference couldn't be read"],
  ["rollover", false, "the period rolled over"],
  ["removed", false, "the budget was removed"],
]) {
  p = await open(`event=budget&quiet=1&budgetend=${end}`);
  await p.evaluate(() => window.notif.quietEnds());
  await p.waitForTimeout(60);
  const list = await pics(p);
  check(
    `fix 2: at the end, ${end}: ${show ? "one 80% warning" : "dropped"}`,
    show ? list.length === 1 && list[0].includes("Reached 80% of its budget.") : list.length === 0 && (await why(p)).includes(words),
    `${JSON.stringify(list)} ${await why(p)}`,
  );
  await p.close();
}
await notShown("fix 2: a count first observed at 100% creates no hold and no notification", "event=budget100", ["A count first observed at 100% or more posts nothing"]);
p = await open("event=budget100&quiet=1");
check("fix 2: nor a hold during quiet hours", await p.evaluate(() => Object.keys(window.notif.S.budgetHolds).length === 0));
await p.close();
p = await open("event=approval&quiet=1");
await p.evaluate(() => window.notif.fire("budget"));
await p.evaluate(() => window.notif.fire("budget2"));
check("fix 2: two budgets are held apart, by budget and period", await p.evaluate(() => Object.keys(window.notif.S.budgetHolds).length === 2));
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
let both = await pics(p);
check("fix 2: both budget pictures come after the wait", both.length === 3 && both[0].includes("Wants to run a command.") && both[1].includes("Reached 80%") && both[2].includes("Reached 80%"), JSON.stringify(both));
await p.evaluate(() => { window.notif.fire("budget"); window.notif.fire("budget2"); });
await p.waitForTimeout(60);
check("fix 2: sending both budget events again in that period adds no picture", (await pics(p)).length === 3);
await p.close();
p = await open("quiet=1&budgetend=friday");
await p.evaluate(() => { window.notif.fire("budget"); window.notif.fire("budget2"); window.notif.quietEnds(); });
await p.waitForTimeout(60);
const friday = await pics(p);
check("fix 2: a weekly hold continues from Thursday into Friday, a daily hold drops at midnight", friday.length === 1 && friday[0].startsWith("Picture of a system notification") && friday[0].includes("Otto") && (await why(p)).includes("Juniper's budget warning was dropped: the period rolled over."), `${JSON.stringify(friday)} ${await why(p)}`);
await p.close();
p = await open("event=budget&quiet=1");
await p.evaluate(() => window.notif.quietEnds());
await p.evaluate(() => window.notif.fire("budget"));
await p.waitForTimeout(60);
check("fix 2: once per budget and period", (await pics(p)).length === 1 && (await why(p)).includes("already warned about in this period"));
await p.close();
p = await open("event=approval&quiet=1");
await p.evaluate(() => window.notif.fire("budget"));
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
let order = await pics(p);
check("ruling 5: a wait is posted before a budget warning, and neither replaces the other", order.length === 2 && order[0].includes("Wants to run a command.") && order[1].includes("Reached 80%"), JSON.stringify(order));
await p.close();

// One per task: a newer event for the task replaces the picture shown; a budget warning has its own slot.
p = await open("event=question");
await p.evaluate(() => window.notif.fire("unsupported"));
await p.waitForTimeout(60);
check("one per task: a newer event replaces the one shown", (await pics(p)).length === 1 && (await pics(p))[0].includes("can't answer yet"), JSON.stringify(await pics(p)));
await p.evaluate(() => window.notif.fire("approval"));
await p.evaluate(() => window.notif.fire("budget"));
await p.waitForTimeout(60);
check("several bots, and a budget beside a wait: each its own", (await pics(p)).length === 3);
await p.close();

// Ruling 6: one interval per start date in the saved zone, across clock changes.
p = await open("");
const iv = (d, f, t, z) => p.evaluate(([d, f, t, z]) => { const r = window.notif.quietInterval(d, f, t, z); return [new Date(r.start).toISOString(), new Date(r.end).toISOString()]; }, [d, f, t, z]);
let r = await iv("2026-10-31", "22:00", "07:00", "America/New_York");
check("ruling 6: across midnight and the autumn change, 22:00 to 07:00", r[0] === "2026-11-01T02:00:00.000Z" && r[1] === "2026-11-01T12:00:00.000Z", r.join(" "));
r = await iv("2026-10-31", "22:00", "01:30", "America/New_York");
check("ruling 6: a repeated end ends on its last occurrence", r[1] === "2026-11-01T06:30:00.000Z", r.join(" "));
r = await iv("2026-11-01", "01:15", "07:00", "America/New_York");
check("ruling 6: a repeated start starts on its first occurrence", r[0] === "2026-11-01T05:15:00.000Z", r.join(" "));
r = await iv("2026-03-07", "22:00", "02:30", "America/New_York");
check("ruling 6: a skipped end uses the first valid time after it", r[1] === "2026-03-08T07:00:00.000Z", r.join(" "));
r = await iv("2026-03-08", "02:30", "07:00", "America/New_York");
check("ruling 6: a skipped start uses the first valid time after it", r[0] === "2026-03-08T07:00:00.000Z", r.join(" "));
await p.close();

// Fix 5: the rail and restored waits stay within what the device received.
for (const ev of ["question", "unsupported", "marlow"]) {
  p = await open(`event=${ev}&device=read`);
  check(`fix 5: a read-only device: no picture and no question mark in the rail (${ev})`, (await pics(p)).length === 0 && !(await text(p, ".bot-list")).includes("a question"));
  await p.close();
}
p = await open("event=failed&device=read");
await click(p, "[data-n-open]");
check("fix 5: a read-only device's opened task offers no Retry and no composer", await p.evaluate(() => !document.querySelector('[data-action="retry-turn"]') && !document.querySelector(".composer-input")));
await p.close();
p = await open("chrome=1&relist=missedq");
await click(p, '[data-bar="drop"]');
await p.evaluate(() => window.notif.fire("question"));
await click(p, '[data-bar="reconnect"]');
await click(p, '.bot[data-bot="juniper"]');
await click(p, '.task[data-task="j1"]');
check("fix 5: a question missed offline appears as a card and a mark, with no new notification", (await pics(p)).length === 0 && (await text(p, ".bot-list")).includes("Waiting for you: a question") && (await text(p, "#transcript")).includes("Which matters more to you"));
await p.close();
p = await open("event=approval&chrome=1&relist=omit");
check("fix 5: the approval's notification is shown", (await pics(p)).length === 1);
await click(p, '[data-bar="drop"]');
await click(p, '[data-bar="reconnect"]');
check("fix 5: a successful list that omits the request withdraws its old notification and mark", (await pics(p)).length === 0 && !(await text(p, ".bot-list")).includes("approve a command"));
await p.close();
p = await open("event=approval&chrome=1&relist=failed");
await click(p, '[data-bar="drop"]');
await click(p, '[data-bar="reconnect"]');
await click(p, '.task[data-task="o1"]');
check("fix 5: a failed list cannot enable the cached card's actions", await p.evaluate(() => { const b = [...document.querySelectorAll("#n-target button.button")]; return b.length > 0 && b.every((x) => x.disabled); }) && (await text(p, "#transcript")).includes("Clawtrate couldn't confirm this request is still open."));
await p.close();

// Fix 3: the on-screen end is the resolved one; touching or overlapping intervals are one.
p = await open("open=settings&quiet=1&quietzone=ny&quietdate=2026-03-08&qfrom=01:00&qto=02:30");
check("fix 3: on March 8 in New York, 01:00 to 02:30 reads Quiet until 03:00", (await text(p, '[data-testid="quiet-now"]')).includes("Quiet until 03:00, New York time."), await text(p, '[data-testid="quiet-now"]'));
await p.close();
p = await open("");
const cont = (d, f, t, z) => p.evaluate(([d, f, t, z]) => { const r = window.notif.continuousInterval(d, f, t, z); return { start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString(), empty: r.empty }; }, [d, f, t, z]);
let c = await cont("2026-10-31", "01:15", "01:10", "America/New_York");
const firstEnd = await p.evaluate(() => new Date(window.notif.quietInterval("2026-10-31", "01:15", "01:10", "America/New_York").end).toISOString());
check("fix 3: the October 31 interval ends at 06:10 UTC, while the November 1 interval began at 05:15 UTC", firstEnd === "2026-11-01T06:10:00.000Z" && (await p.evaluate(() => new Date(window.notif.quietInterval("2026-11-01", "01:15", "01:10", "America/New_York").start).toISOString())) === "2026-11-01T05:15:00.000Z");
check("fix 3: so the first ending releases nothing: the continuous interval runs to November 2, 06:10 UTC", c.end === "2026-11-02T06:10:00.000Z" && c.end !== firstEnd && !c.empty, JSON.stringify(c));
c = await cont("2026-03-08", "02:10", "02:40", "America/New_York");
check("fix 3: March 8, 02:10 to 02:40 is empty (both resolve to 07:00 UTC)", c.empty && c.start === "2026-03-08T07:00:00.000Z" && c.end === "2026-03-08T07:00:00.000Z", JSON.stringify(c));
await p.close();
p = await open("event=approval&quiet=1&chrome=1");
await click(p, '[data-bar="drop"]');
await click(p, '[data-bar="quietend"]');
const offlineEnd = (await pics(p)).length;
await p.close();
p = await open("event=approval&quiet=1&chrome=1");
await click(p, '[data-bar="wake"]');
check("fix 3: ending offline and waking late still drop holds", offlineEnd === 0 && (await pics(p)).length === 0 && (await p.evaluate(() => window.notif.S.held.length === 0)));
await p.close();

// The bar fires events by clicking.
p = await open("chrome=1");
await p.selectOption('[data-bar="event"]', "question");
await click(p, '[data-bar="fire"]');
check("the bar: Happens fires the chosen event", (await pics(p)).join(" ").includes("Asked you a question."));
await p.selectOption('[data-bar="device"]', "read");
await p.selectOption('[data-bar="event"]', "approval");
await click(p, '[data-bar="fire"]');
check("the bar: a read-only device's approval words", (await pics(p)).join(" ").includes("This device doesn't have the approval request."));
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
await opens("a wait it only saw: the task with the note, no answer offered", "event=approval&device=other", { words: ["A run is waiting for approval. This device doesn't have the approval request."], focus: "n-target", not: ["Allow once", "Deny"] });
await opens("an approval on an admin or reviewer device: the card", "event=approval&device=admin", { words: ["Otto wants to run a command", "Allow once", "Deny"], focus: "n-target" });
await opens("a plugin's approval: its card", "event=generic", { pill: "Weekly backup check", words: ["Otto wants to use the notes plugin", "Allow", "Deny"], focus: "n-target" });
await opens("a question this app can't answer: the readable card", "event=unsupported", { words: ["Juniper asked something this app can't answer yet", "Nothing is sent for it from here."], focus: "n-target" });
await opens("a wait on a read-only device: conversation.md §3's note", "event=approval&device=read", { words: ["This device can't see it on a read-only connection.", "Request access"], focus: "n-target", not: ["Allow once"] });
await opens("a question: the card, focused", "event=question", { pill: "Heat pump vs. gas furnace", words: ["Which matters more to you: running cost or upfront price?"], focus: "n-target" });
await opens("a question in another bot's task: that bot and task", "event=marlow", { pill: "Notes for Pip", words: ["Marlow is working on a message from Pip.", "Should the plan keep Saturday morning free?"], focus: "n-target" });
await opens("a budget warning: the bot's open task, at the line", "event=budget", { pill: "Disk almost full", words: ["Otto has used 82% of its weekly budget: 1.64M of 2M tokens."], focus: "n-target" });
p = await open("event=budget&quiet=1&budgetend=over100");
await p.evaluate(() => window.notif.quietEnds());
await p.waitForTimeout(60);
await click(p, "[data-n-open]");
await p.waitForTimeout(150);
check("fix 7: a held warning released at 104% opens the note above the composer, with no 82% line", (await focusedId(p)) === "n-target" && (await text(p, '[data-testid="budget-note"]')).includes("Otto has reached its weekly warning budget.") && !(await text(p, "#transcript")).includes("82%"));
await p.close();
p = await open("event=budget");
await p.evaluate(() => { window.notif.S.budgetRemoved["bot:otto"] = true; });
await click(p, "[data-n-open]");
await p.waitForTimeout(150);
check("fix 7: a warning whose budget was later removed opens the task with the missing-item outcome", (await text(p, "#status-strip")).includes("Clawtrate couldn't find that item in this task.") && !(await p.$('[data-testid="budget-line"], [data-testid="budget-note"]')));
await p.close();

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
await clickFails("not in the rail and not found by its key: it says it couldn't find the task, never that it was deleted", "event=finished&click=gone", { strip: "Clawtrate couldn't find that task on this gateway.", words: ["Pick a task"], not: ["3:25 AM", "deleted", "no longer"] });
await clickFails("not in the rail but found by its key: the task opens", "event=finished&click=unlisted", { words: ["Yes. Last night's backup finished at 3:25 AM"] });
await clickFails("the bot is gone: the current page stays", "event=finished&click=botgone", { strip: "Clawtrate couldn't open that bot on this gateway.", words: ["Disk almost full on the media box"] });
await clickFails("the item is gone from a confirmed task: the task opens and says so", "event=approval&click=itemgone", { strip: "Clawtrate couldn't find that item in this task.", words: ["Disk almost full on the media box"], not: ["Allow once"] });
await clickFails("the connection is down: the task opens from what was loaded", "event=approval&click=offline", { strip: "Reconnecting in 4s", words: ["Otto wants to run a command", "Clawtrate is reconnecting. You can answer once the gateway confirms this request is still open."] });
await clickFails("another gateway: nothing opens", "event=approval&click=othergw", { strip: "That notification came from Studio gateway. Clawtrate is using Home gateway now.", not: ["Otto wants to run a command"] });
await clickFails("no record: Clawtrate comes forward and opens nothing", "event=approval&click=stale", { why: "It has no record of that notification, so nothing opened.", not: ["Otto wants to run a command"] });
p = await open("event=approval&click=othergw");
await click(p, "[data-n-open]");
check("another gateway: the strip offers Your gateways", (await text(p, "#status-strip")).includes("Your gateways"));
await click(p, '#status-strip [data-n="gateways"]');
check("Your gateways opens that Settings section", (await text(p, "#b-section-title")) === "Your gateways");
await p.close();
for (const fixture of ["gone", "refused"]) {
  p = await open(`event=finished&click=${fixture}`);
  const before = (await text(p, ".bot-list")).includes("Weekly backup check");
  await click(p, "[data-n-open]");
  check(`fix 6: ${fixture}: the missing task is absent both before and after the click`, !before && !(await text(p, ".bot-list")).includes("Weekly backup check"));
  check(`fix 6: ${fixture}: it says it couldn't find the task, opens no composer and selects no task`, (await text(p, "#status-strip")).includes("Clawtrate couldn't find that task on this gateway.") && (await p.evaluate(() => !document.querySelector(".composer-input") && !document.querySelector('.task[aria-current="true"]'))));
  await p.close();
}
p = await open("event=finished&click=unlisted");
const listedBefore = (await text(p, ".bot-list")).includes("Weekly backup check");
await click(p, "[data-n-open]");
await p.waitForTimeout(150);
check("fix 6: unlisted: absent from the rail before the click; the by-key read opens it at the reply", !listedBefore && (await focusedId(p)) === "n-target" && (await text(p, "#transcript")).includes("Yes. Last night's backup finished at 3:25 AM"));
await p.close();

// Fix 6: answers stay disabled through a real disconnect, until a reconnect lists that exact request.
for (const ev of ["approval", "question"]) {
  p = await open(`event=${ev}&chrome=1`);
  await click(p, '[data-bar="drop"]');
  await click(p, "[data-n-open]");
  await p.waitForTimeout(150);
  const sel = "#n-target button.button, #n-target button.option";
  check(`fix 6: after the bar's Disconnect, the ${ev} card's answers exist and are disabled`, await p.evaluate((sel) => { const b = [...document.querySelectorAll(sel)]; return b.length > 0 && b.every((x) => x.disabled); }, sel));
  await click(p, '[data-bar="reconnect"]');
  check(`fix 6: a reconnect that lists that exact request enables them`, await p.evaluate((sel) => { const b = [...document.querySelectorAll(sel)]; return b.length > 0 && b.every((x) => !x.disabled); }, sel));
  await p.close();
}
p = await open("event=approval&chrome=1&relist=omit");
await click(p, '[data-bar="drop"]');
await click(p, "[data-n-open]");
await click(p, '[data-bar="reconnect"]');
check("fix 6: a reconnect whose list omits the request leaves its answers disabled and says the item is missing", (await p.evaluate(() => [...document.querySelectorAll("#n-target button.button")].every((x) => x.disabled))) && (await text(p, "#status-strip")).includes("Clawtrate couldn't find that item in this task."));
await p.close();
for (const ev of ["approval", "question"]) {
  p = await open(`event=${ev}&click=offline`);
  await click(p, "[data-n-open]");
  await p.waitForTimeout(150);
  check(`offline shortcut: the cached ${ev} card's answers are disabled`, await p.evaluate(() => [...document.querySelectorAll("#n-target button.button, #n-target button.option, #n-target input")].every((x) => x.disabled)));
  await p.close();
}
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
    "Show bot names in notifications",
    "A bot's name can appear on a locked screen and can stay in your system's notification list.",
    "Budget warnings",
    "When a bot has used 80% of a budget.",
    "Clawtrate shows desktop notifications for events it receives while running and connected. Missed events can appear in your tasks when it reconnects.",
    "It can't see whether macOS allows them or whether a Focus is on.",
    "Quiet hours",
    "Clawtrate posts no new notifications during quiet hours. Clawtrate can notify you after quiet hours if the item is still waiting and your settings allow it.",
    "Your bots",
    "Juniper",
    "Marlow",
    "Otto",
    "Pip",
  ]),
  missing(s, ["Show bot names in notifications"]),
);
check(
  "Settings: each group says where it is kept",
  (await text(p, '[data-testid="kept-device"]')) === "Kept on this computer." &&
    (await text(p, '[data-testid="kept-quiet"]')) === "Kept for you on this gateway, so your other devices show the same." &&
    (await text(p, '[data-testid="kept-bots"]')) === "Kept for you on this gateway, so your other devices show the same.",
);
check("Settings: the section sits after Appearance and before System", await p.evaluate(() => [...document.querySelectorAll("[data-n-section]")].map((x) => x.textContent.trim()).join(",").includes("Appearance,Notifications,System")));
check("Settings: every switch on this computer is on by default, and there is no previews switch", await p.evaluate(() => ["master", "names", "budgetsw"].every((k) => document.querySelector(`[data-n-set="${k}"]`).getAttribute("aria-checked") === "true") && !document.querySelector('[data-n-set="previews"]')));
check("Settings: Otto's line counts a task with its own setting", s.includes("On · 1 task off"));
check("Settings: every switch has role switch and a name", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-switch")].every((x) => x.getAttribute("role") === "switch" && x.getAttribute("aria-label"))));
check("Settings: the title takes focus", (await focusedId(p)) === "b-section-title");
await click(p, '[data-n-bot="otto"]');
check("saving: the switch is disabled and says Saving…", (await text(p, '[data-row="bot-otto"]')).includes("Saving…") && (await p.isDisabled('[data-n-bot="otto"]')));
await p.waitForTimeout(650);
check("saved: the switch shows what was read back", (await p.getAttribute('[data-n-bot="otto"]', "aria-checked")) === "false");
check("saved: announced only once read back", (await text(p, "#settings-live")) === "Otto's notifications are off");
await click(p, '[data-n-set="names"]');
await p.waitForTimeout(450);
check("Show bot names off: saved, announced, and its line says what notifications say", (await p.getAttribute('[data-n-set="names"]', "aria-checked")) === "false" && (await text(p, "#settings-live")) === "Bot names are hidden in notifications" && (await text(p, '[data-row="names"]')).includes('New notifications say "Clawtrate" and the kind of event. Previously posted names can stay in your system\'s notification list.'));
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
  ["windows", "while running and connected. Missed events can appear in your tasks when it reconnects. Closing its window quits it. It can't see whether Windows allows them or whether Do Not Disturb is on."],
  ["linux", "while running and connected. Missed events can appear in your tasks when it reconnects. None is shown while its window is focused."],
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
  () => !document.querySelector('[data-n-set="master"], [data-n-set="names"], [data-n-set="budgetsw"], [data-testid="system-note"]'),
);
await settingsState("a build that can't show notifications, Windows", "platform=none&os=windows", ["can't show notifications on Windows.", "in the rail and on the taskbar button."]);
await settingsState("set on a device in another zone: tonight's interval, converted", "prefs=elsewhere&quietset=1", ["22:00 to 07:00, Lisbon time, where they were set. Tonight that's 23:00 to 08:00 here. Saving here sets them in Berlin time."]);
await settingsState("a post that failed", "failed=1", ["Clawtrate couldn't post a notification at 5:41 PM. Check your system's notification settings.", "Dismiss"], () => !document.body.textContent.includes("didn't show"));
await settingsState("a build that can't show notifications, settings kept only here", "platform=none&prefs=device", ["This copy of Clawtrate can't show notifications on macOS."], () => !document.querySelector("#settings-dialog").textContent.includes("apply on your other devices"));
await settingsState(
  "read-only: values shown, your settings disabled, this computer's not",
  "access=read",
  ["Read-only.", "Changing quiet hours and your bots' notifications needs more access.", "Request access"],
  () => [...document.querySelectorAll("[data-n-bot], [data-n-set='quiet']")].every((x) => x.disabled) && !document.querySelector('[data-n-set="master"]').disabled,
);
await settingsState("quiet now, with a wait held", "quiet=1&event=approval", ["Quiet until 07:00, Lisbon time. 1 item is held. Clawtrate can notify you after quiet hours if the item is still waiting and your settings allow it."], () => !document.querySelector("#settings-dialog").textContent.includes("It will be shown then"));
await settingsState("no room to turn a bot off", "botsfull=1", ["Your bots"]);
p = await open("open=settings&botsfull=1");
await click(p, '[data-n-bot="otto"]');
const BOT_ROOM = "There's no room to save this switch with your quiet hours. Turn another bot back on first.";
check("fix 4: no room for a bot switch in Settings: the line beneath it, the old value kept", (await text(p, '[data-row="bot-otto"]')).includes(BOT_ROOM) && (await p.getAttribute('[data-n-bot="otto"]', "aria-checked")) === "true" && (await p.evaluate(() => window.notif.S.bots.otto === true)));
check("fix 4: the exact refused value crosses 4,096 bytes; the one kept does not", await p.evaluate(() => window.notif.S.lastRefused.bytes > window.notif.LIMIT && window.notif.S.lastRefused.before <= window.notif.LIMIT));
await click(p, '[data-n-set="quiet"]');
check("fix 4: no room to save quiet hours: the line beneath Quiet hours, the old value kept", (await text(p, '[data-row="quiet"]')).includes("There's no room to save quiet hours. Turn a bot's notifications back on first.") && (await p.getAttribute('[data-n-set="quiet"]', "aria-checked")) === "false" && (await p.evaluate(() => window.notif.S.lastRefused.bytes > window.notif.LIMIT && !window.notif.S.quiet.saved)));
await p.close();
p = await open("open=bot&botsfull=1");
await click(p, '#panel-settings [data-n-bot="otto"]');
check("fix 4: the same refusal beneath the switch on the bot's page", (await text(p, '#panel-settings [data-row="bot-otto"]')).includes(BOT_ROOM) && (await p.getAttribute('#panel-settings [data-n-bot="otto"]', "aria-checked")) === "true");
await p.close();
p = await open("open=settings&failed=1");
await click(p, '[data-n="dismiss-failed"]');
check("ruling 9: the failed note is cleared when dismissed", !(await p.$('[data-testid="failed-note"]')));
await p.close();
p = await open("failed=1");
await p.evaluate(() => window.notif.fire("finished"));
await p.keyboard.press("Meta+,");
await p.waitForTimeout(80);
check("ruling 9: the failed note is cleared by a later shown callback", !(await p.$('[data-testid="failed-note"]')));
await p.close();

p = await open("open=settings&prefs=readfail");
await click(p, '[data-n="retry-read"]');
check("couldn't read: Try again reads and shows the settings", (await text(p, "#settings-dialog")).includes("Your bots"));
await p.close();
p = await open("open=settings&access=read");
await click(p, '#settings-dialog [data-n="request"]');
check("read-only: Request access asks the gateway", (await text(p, "#settings-dialog")).includes("Asking the gateway…"));
await p.waitForTimeout(400);
check("read-only: then waits for the owner", (await text(p, "#settings-dialog")).includes("Waiting for the gateway's owner."));
await p.evaluate(() => window.notif.resolveReq("granted"));
await p.waitForTimeout(80);
check("ruling 7: approved: the switches are enabled and it says so", !(await p.isDisabled('[data-n-bot="otto"]')) && (await text(p, "#settings-dialog")).includes("Access granted. You can change these now.") && !(await p.$('[data-testid="access-bar"]')));
await p.close();
for (const [answer, words] of [
  ["denied", "The request was denied. Nothing changed. This device can still read."],
  ["expired", "The request expired before it was approved."],
  ["failed", "Couldn't send the request. The gateway did not answer."],
]) {
  p = await open("open=settings&access=read");
  await click(p, '#settings-dialog [data-n="request"]');
  await p.waitForTimeout(400);
  await p.evaluate((a) => window.notif.resolveReq(a), answer);
  await p.waitForTimeout(80);
  check(`ruling 7: the request ${answer}: its words, the switches still disabled`, (await text(p, "#settings-dialog")).includes(words) && (await p.isDisabled('[data-n-bot="otto"]')));
  await p.close();
}
p = await open("open=settings&prefs=savefail");
await click(p, '[data-n-bot="otto"]');
await p.waitForTimeout(650);
check("ruling 7: refused, with the value read back: it says so", (await p.getAttribute('[data-n-bot="otto"]', "aria-checked")) === "true" && (await text(p, '[data-row="bot-otto"]')).includes("The gateway refused the change. Otto's notifications are On."));
await p.close();
p = await open("open=settings&prefs=unknown");
await click(p, '[data-n-bot="otto"]');
await p.waitForTimeout(650);
check("ruling 7: an outcome that couldn't be confirmed says so, as last read", (await text(p, '[data-row="bot-otto"]')).includes("Couldn't confirm the change. Otto's notifications were last read as On.") && !(await text(p, "#settings-dialog")).includes("still on"));
check("ruling 7: until a new read, your settings can't be changed", await p.isDisabled('[data-n-bot="pip"]'));
check("ruling 7: and no notification about a bot is shown", await p.evaluate(() => window.notif.decide({ bot: "otto", task: "o3", kind: "finished", run: "x" }).none?.includes("aren't confirmed")));
await click(p, '[data-n="check-again"]');
await p.waitForTimeout(80);
check("ruling 7: Check again reads what the gateway holds", (await p.getAttribute('[data-n-bot="otto"]', "aria-checked")) === "false" && !(await p.isDisabled('[data-n-bot="pip"]')));
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
check("the bot's page: notes for this computer's switch and quiet hours", !missing(s, ["Notifications are off on this computer.", "Settings", "Quiet until 07:00, Lisbon time."]));
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
check("ruling 8: no room for another task setting: the words, nothing saved", (await text(p, '[data-testid="task-room"]')).includes('There\'s no room for another task setting. Set a task back to "Same as bot" first.') && (await p.evaluate(() => !Object.keys(window.notif.S.tasks).some((k) => k.includes(":o3-")))));
check("fix 4: the exact refused task value crosses 4,096 bytes; the stored one does not", await p.evaluate(() => window.notif.S.lastRefused.bytes > window.notif.LIMIT && window.notif.bytes(window.notif.S.tasks) <= window.notif.LIMIT && window.notif.S.lastRefused.before === window.notif.bytes(window.notif.S.tasks)));
await p.close();
p = await open("open=details&access=read");
check("Details, read-only: the select disabled and the access bar", (await p.isDisabled('[data-n="task-menu"]')) && (await text(p, "#panel-details")).includes("Request access"));
await p.close();
p = await open("open=details&prefs=savefail");
await click(p, '[data-n="task-menu"]');
await click(p, '[data-n-task="on"]');
await p.waitForTimeout(650);
check("Details: refused keeps the value read back and says so", (await text(p, '[data-testid="task-error"]')).includes("The gateway refused the change.") && (await text(p, '[data-testid="task-setting"]')).includes("Same as Otto (on)"));
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
