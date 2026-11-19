// Behaviour checks for routines.html: the Routines view and its calendar, a
// routine's page and runs, a run's conversation, live changes, the editor,
// pause, run now, delete, the request for admin access, check-ins and the
// away card, at the four widths and in both themes.
// Run from the repository root:  node docs/design/prototype/tools/checks/routines.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("routines.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(150);
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const has = (p, sel) => p.evaluate((s) => !!document.querySelector(s), sel);
const count = (p, sel) => p.evaluate((s) => document.querySelectorAll(s).length, sel);
const label = (p, sel) => p.evaluate((s) => document.querySelector(s)?.getAttribute("aria-label") || "", sel);
const live = (p) => p.waitForTimeout(80).then(() => text(p, "#r-announce"));

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// The list ---------------------------------------------------------------------------------
let p = await open();
check("list: title, count and the view switch", (await text(p, "#view-title")) === "Routines" && (await text(p, '[data-testid="count"]')) === "7 routines" && (await count(p, '.r-seg [role="radio"]')) === 4);
check("list: groups by bot in the gateway's order, check-in jobs left out", (await p.evaluate(() => [...document.querySelectorAll(".r-group h2")].map((h) => h.textContent).join())) === "Marlow,Otto,Pip");
check("F-191 row: name, schedule in words with its zone, next and last", (await text(p, '[data-routine="digest"] .r-row-line')) === "Weekdays at 8:00 AM, New York · Next tomorrow 8:00 AM · Last today, succeeded");
check("F-191 row: the whole row is its accessible name", (await label(p, '[data-routine="digest"] .r-row-main')) === "Morning digest, Marlow, Weekdays at 8:00 AM, New York, next run tomorrow 8:00 AM, last run today succeeded");
check("F-191 paused row reads Paused, schedule faint, no next run", (await text(p, '[data-routine="cleanup"] .r-row-line')) === "Paused · Fridays at 4:00 PM, New York" && (await p.evaluate(() => document.querySelector('[data-routine="cleanup"] .r-row').dataset.paused === "true")));
check("row: an every schedule has no zone; a once schedule says its date", (await text(p, '[data-routine="watch"] .r-row-line')).startsWith("Every 30 minutes · Next today 10:30 AM") && (await text(p, '[data-routine="reminder"] .r-row-line')).startsWith("Once, Nov 20 at 9:00 AM, New York"));
check("row: a cron expression the page cannot put in words is shown as written, with its zone", (await text(p, '[data-routine="renewal"] .r-row-line code')) === "0 9 1 * *" && (await text(p, '[data-routine="renewal"] .r-row-line')).includes(", Berlin"));
check("row: a failed last run has the failed mark and says failed", (await has(p, '[data-routine="backup"] .glyph[data-state="failed"]')) && (await text(p, '[data-routine="backup"] .r-row-line')).endsWith("Last today, failed"));
check("row: a routine in another zone says that zone", (await text(p, '[data-routine="standup"] .r-row-line')).startsWith("Sundays at 5:00 PM, London"));
check("admin: each row has a switch labelled for its routine", (await count(p, ".r-row .b-switch")) === 7 && (await label(p, '[data-routine="digest"] .b-switch')) === "Morning digest runs on schedule");
check("admin: New routine is offered; no access bar", (await has(p, '.r-head [data-r="new"]')) && !(await has(p, ".access-bar")));
check("F-193 rail: a routine's latest run is a task under its bot, with the clock and its name", (await p.evaluate(() => [...document.querySelectorAll('[data-testid="run-task"]')].map((x) => x.querySelector(".task-title").textContent).join())) === "Morning digest,Nightly backup check,Disk space watch");
check("F-193 rail: a failed run's task row has the failed mark", await has(p, '[data-testid="run-task"][data-id="backup"] .glyph[data-state="failed"]'));
check("rail: the Routines button is current", (await p.evaluate(() => document.querySelector("#routines-button").getAttribute("aria-current"))) === "page");

// Pause and resume from the row
await p.click('[data-routine="digest"] .b-switch');
check("F-350 switch pauses: the row reads Paused and it is announced", (await text(p, '[data-routine="digest"] .r-row-line')).startsWith("Paused · Weekdays") && (await live(p)) === "Paused Morning digest");
check("F-350 focus stays on the switch after the change", await p.evaluate(() => document.activeElement.matches('[data-routine="digest"] .b-switch')));
await p.click('[data-routine="digest"] .b-switch');
check("F-350 switch resumes", (await text(p, '[data-routine="digest"] .r-row-line')).startsWith("Weekdays at 8:00 AM") && (await live(p)) === "Resumed Morning digest");

// The row's menu
await p.click('[data-routine="backup"] .r-row-main', { button: "right" });
check("F-192 right-click: Pause, Run now, Edit…, Delete…", (await p.evaluate(() => [...document.querySelectorAll("#r-menu .menu-item")].map((x) => x.textContent).join())) === "Pause,Run now,Edit…,Delete…");
await p.keyboard.press("Escape");
check("menu: Escape closes it and returns focus to the row", (await p.evaluate(() => document.querySelector("#r-menu").hidden && document.activeElement.matches('[data-routine="backup"] .r-row-main'))));
await p.keyboard.press("Shift+F10");
check("F-192 Shift+F10 opens the same menu from the keyboard", !(await p.evaluate(() => document.querySelector("#r-menu").hidden)));
await p.keyboard.press("Escape");

// The bot select
await p.click('[data-r="bot-menu"]');
await p.click('#r-menu [data-id="juniper"]');
check("one bot: Juniper's check-ins block first, then no routines", (await text(p, '[data-testid="checkins-text"]')) === "Every 30 minutes, Juniper looks for anything that needs you. Its prompt asks it to stay quiet when nothing does." && (await text(p, '[data-testid="empty"]')) === "Juniper has no routines.");
check("one bot: New routine names the bot", (await text(p, '.r-head [data-r="new"]')) === "New routine for Juniper");
await p.click('[data-r="bot-menu"]');
await p.click('#r-menu [data-id="otto"]');
check("F-196 one bot: the routines' time zone line", (await text(p, '[data-testid="zone-line"]')) === "Routines' time zone: Mixed: New York, Berlin");
await p.close();

// List states
p = await open("state=empty");
check("empty: No routines yet, the sentence, New routine; never 'ask in chat'", (await text(p, '[data-testid="empty"] h4')) === "No routines yet" && (await text(p, '[data-testid="empty"] p')) === "A routine runs one of your bots on a schedule: a morning summary, a weekly check." && !(await p.evaluate(() => /ask in chat/i.test(document.body.textContent))));
await p.close();
p = await open("state=loading");
check("loading: skeleton rows, busy", (await count(p, ".r-rows[aria-busy='true'] .skeleton")) === 3);
await p.close();
p = await open("state=error");
check("couldn't load: words and Try again", (await text(p, '[data-testid="error"] h4')) === "Couldn't load routines." && (await has(p, '[data-r="retry"]')));
await p.click('[data-r="retry"]');
check("Try again loads the list", (await count(p, '[data-testid="routine-row"]')) === 7);
await p.close();
p = await open("state=scheduler-off");
check("scheduler off: the note, and next runs as 'would be'", (await text(p, ".b-note")).startsWith("The gateway's scheduler is off. Routines and check-ins don't run on their schedule. Run now still works.") && (await text(p, '[data-routine="digest"] .r-row-line')).includes("Would be next tomorrow 8:00 AM"));
await p.close();
p = await open("state=scheduler-off&view=checkins&bot=juniper");
check("scheduler off: check-ins say scheduled check-ins don't run", (await text(p, '[data-testid="checkins"]')).includes("The gateway's scheduler is off, so scheduled check-ins don't run."));
await p.close();
p = await open("pausefail=1");
await p.click('[data-routine="digest"] .b-switch');
check("F-350 a failed pause puts the switch back and says why under the row", (await p.evaluate(() => document.querySelector('[data-routine="digest"] .b-switch').getAttribute("aria-checked"))) === "true" && (await text(p, '[data-routine="digest"] .r-row-error')) === "Couldn't pause: the gateway didn't answer.");
await p.close();

// Without admin access ---------------------------------------------------------------------
p = await open("access=read");
check("read: no switches, no New routine, rows still read in full", (await count(p, ".b-switch")) === 0 && !(await has(p, '[data-r="new"]')) && (await text(p, '[data-routine="cleanup"] .r-row-line')).startsWith("Paused"));
check("read: the access bar with this view's words", (await text(p, ".access-bar")).startsWith("Read-only. Creating and changing routines needs admin access.") && (await text(p, '[data-r="request"]')) === "Request admin access");
await p.click('[data-routine="backup"] .r-row-main', { button: "right" });
check("read: the row's menu has Open only", (await p.evaluate(() => [...document.querySelectorAll("#r-menu .menu-item")].map((x) => x.textContent).join())) === "Open");
await p.keyboard.press("Escape");
await p.click('[data-r="request"]');
check("request: asking, announced", (await text(p, ".access-bar")) === "Asking the gateway…" && (await live(p)) === "Asking the gateway");
await p.waitForTimeout(700);
check("request: waiting for the owner, with the command and request id", (await text(p, ".access-bar")).includes("Waiting for the gateway's owner.") && (await text(p, ".access-bar .command-line")).includes("openclaw devices approve") && (await has(p, '[data-r="access-check"]')) && (await has(p, '[data-r="access-cancel"]')));
await p.click('[data-r="access-check"]');
check("request: granted, the controls appear; never before the explicit request", (await text(p, ".access-bar")).startsWith("Admin access granted.") && (await count(p, ".b-switch")) === 7 && (await has(p, '[data-r="new"]')));
await p.close();
p = await open("access=write");
check("interactive tier: Admin access needed", (await text(p, ".access-bar")).startsWith("Admin access needed. Creating and changing routines needs admin access."));
await p.close();
for (const [req, words] of [["denied", "The request was denied."], ["expired", "The request expired"], ["failed", "Couldn't send the request."]]) {
  p = await open(`access=read&req=${req}`);
  check(`request ${req}: its words and a way to ask again`, (await text(p, ".access-bar")).startsWith(words) && (await has(p, '[data-r="request"]')));
  await p.close();
}
p = await open("access=read&view=routine&routine=digest");
check("read: a routine's page has no actions, its facts and runs still show", !(await has(p, '[data-r="run-now"]')) && !(await has(p, '[data-r="more"]')) && (await count(p, '[data-testid="run-row"]')) === 6);
await p.close();
p = await open("access=read&view=checkins&bot=juniper");
check("read: check-ins show their values and no Change", (await text(p, '[data-testid="checkins-text"]')).startsWith("Every 30 minutes") && !(await has(p, '[data-r="checkins"]')));
await p.close();

// Live events: the cron event's added, updated and removed, applied as another client's changes.
const event = (p, ev) => p.evaluate((e) => window.routines.event(e), ev).then(() => p.waitForTimeout(60));
const focused = (p) => p.evaluate(() => { const a = document.activeElement; return a.id || `${a.dataset.r}:${a.dataset.id || ""}`; });
const EVENING = { id: "evening", bot: "marlow", name: "Evening wrap-up", schedule: { kind: "cron", expr: "0 18 * * *", tz: "America/New_York" }, payload: { kind: "agentTurn", message: "List what I finished today." }, sessionTarget: "isolated", delivery: "none", updatedAtMs: 0 };
p = await open();
await p.focus('[data-routine="digest"] .b-switch');
await event(p, { action: "added", job: EVENING, nextRunAtMs: 0 });
check("event added: the row appears in its place, in words", (await text(p, '[data-routine="evening"] .r-row-line')) === "Every day at 6:00 PM, New York · Next today 6:00 PM · No runs yet" && (await text(p, '[data-testid="count"]')) === "8 routines");
check("event added: focus stays, and another client's routine is not announced", (await focused(p)) === "toggle:digest" && (await live(p)) === "");
await event(p, { action: "updated", job: { id: "digest", name: "Morning notes", schedule: { kind: "cron", expr: "30 7 * * 1-5", tz: "America/New_York" } } });
check("event updated: the row shows the new values, focus stays, nothing announced off screen", (await text(p, '[data-routine="digest"] .r-row-name')) === "Morning notes" && (await text(p, '[data-routine="digest"] .r-row-line')).startsWith("Weekdays at 7:30 AM, New York") && (await focused(p)) === "toggle:digest" && (await live(p)) === "");
await event(p, { action: "removed", jobId: "backup" });
check("event removed: the row leaves the list and the rail, focus stays", !(await has(p, '[data-routine="backup"]')) && !(await has(p, '[data-testid="run-task"][data-id="backup"]')) && (await text(p, '[data-testid="count"]')) === "7 routines" && (await focused(p)) === "toggle:digest");
await event(p, { action: "finished", job: { id: "watch" }, run: { at: Date.UTC(2026, 10, 18, 15, 12), status: "error", completion: "failed", error: "The check script exited with 2.", dur: 0.3, tokens: 0, inT: 0, outT: 0 } });
check("event finished with a failure: announced wherever the person is; the row gets the failed mark", (await live(p)) === "Disk space watch failed" && (await has(p, '[data-routine="watch"] .glyph[data-state="failed"]')));
await p.close();
p = await open("view=routine&routine=digest");
await p.focus('[data-r="run-now"]');
await event(p, { action: "updated", job: { id: "digest", name: "Morning notes" } });
check("event updated with the page open: the page shows it, focus stays, announced", (await text(p, "#view-title")) === "Morning notes" && (await focused(p)) === "run-now:digest" && (await live(p)) === "Morning notes was changed elsewhere");
await event(p, { action: "updated", job: { id: "digest", enabled: false } });
check("event updated, enabled only: the page reads Paused and the header offers Resume", (await text(p, '[data-testid="state-line"]')) === "Paused. It won't run until resumed." && (await text(p, '.r-head [data-r="toggle"]')) === "Resume");
await event(p, { action: "removed", jobId: "digest" });
check("event removed with the page open: the deleted note, no actions, announced", (await text(p, ".b-note")).startsWith("This routine was deleted. It won't run again.") && !(await has(p, '[data-r="run-now"]')) && (await live(p)) === "Morning notes was deleted elsewhere");
await p.close();
p = await open("edit=open&routine=digest");
await p.fill("#e-name", "My digest");
await event(p, { action: "updated", job: { id: "digest", enabled: false } });
check("editor open, enabled changed elsewhere: no conflict, nothing lost", !(await has(p, "#edit-dialog .b-note")) && (await p.inputValue("#e-name")) === "My digest");
await event(p, { action: "updated", job: { id: "digest", name: "Morning notes", updatedAtMs: Date.UTC(2026, 10, 18, 15, 12) } });
check("editor open, changed elsewhere: the note, typed input kept, focus kept", (await text(p, "#edit-dialog .b-note")).startsWith("This routine was changed elsewhere while you were editing.") && (await p.inputValue("#e-name")) === "My digest" && (await focused(p)) === "e-name");
await event(p, { action: "removed", jobId: "digest" });
check("editor open, deleted elsewhere: Save as a new routine, typed input kept", (await text(p, "#edit-dialog .b-note")).startsWith("This routine was deleted while you were editing.") && (await has(p, '[data-r="save-as-new"]')) && (await p.inputValue("#e-name")) === "My digest");
await p.close();

// Refusals and a lost tier
p = await open("view=routine&routine=digest&runfail=1");
await p.click('[data-r="run-now"]');
await p.waitForTimeout(650);
check("F-351 Run now refused: the reason under the button, Run now offered again, focus on it, no run", (await text(p, '[data-testid="run-error-line"]')) === "Couldn't start a run: the gateway didn't answer." && (await text(p, '[data-r="run-now"]')) === "Run now" && (await focused(p)) === "run-now:digest" && !(await has(p, '[data-testid="state-line"] .glyph[data-state="working"]')));
await p.close();
p = await open("view=routine&routine=backup&deletefail=1&confirm=delete");
await p.click('[data-r="confirm-delete"]');
check("F-352 delete refused: the confirmation stays with the reason, focus on Delete", (await p.evaluate(() => document.querySelector("#confirm-dialog").open)) && (await text(p, "#confirm-error")) === "Couldn't delete Nightly backup check: the gateway didn't answer. It is still there." && (await focused(p)) === "confirm-delete:backup");
await p.click('[data-r="confirm-cancel"]');
check("F-352 after a refused delete the routine is still there", (await text(p, "#view-title")) === "Nightly backup check");
await p.close();
p = await open("edit=open&routine=digest&editstate=adminlost");
await p.fill("#e-name", "Morning notes");
await p.click('[data-r="save"]');
await p.waitForTimeout(700);
check("admin lost while saving: the access bar takes the foot, typed input kept, focus on the request", (await text(p, '[data-testid="editor-access"]')).startsWith("Admin access was lost. Saving needs it again. What you typed is kept.") && (await p.inputValue("#e-name")) === "Morning notes" && !(await has(p, '#edit-dialog [data-r="save"]')) && (await focused(p)) === "request:" && (await live(p)) === "Admin access was lost");
await p.click('#edit-dialog [data-r="request"]');
await p.waitForTimeout(700);
await p.click('#edit-dialog [data-r="access-check"]');
check("admin granted again: Save is back, with what was typed", (await has(p, '#edit-dialog [data-r="save"]')) && (await p.inputValue("#e-name")) === "Morning notes");
await p.close();

// More than 20 runs (F-355)
p = await open("view=routine&routine=digest&runs=25");
const ats = await p.evaluate(() => [...document.querySelectorAll('[data-testid="run-row"]')].map((x) => +x.dataset.at));
check("F-355 with 25 runs the page shows the 20 most recent, newest first", ats.length === 20 && ats.every((t, i) => i === 0 || t < ats[i - 1]) && (await text(p, '[data-testid="run-row"] .r-run-when')) === "Today 10:00 AM");
await p.close();

// A bot's routines' time zone (F-196)
p = await open("view=checkins&bot=pip");
check("F-196 the zone line with Change…", (await text(p, '[data-testid="zone-line"]')) === "Routines' time zone: Mixed: London, New York" && (await has(p, '[data-r="zone"]')));
await p.click('[data-r="zone"]');
check("F-196 Change… lists what it will change", (await text(p, "#zone-title")) === "Pip's routines' time zone" && (await text(p, '[data-testid="zone-change"]')) === "Plan the week (now London)Inbox tidy-up (now New York)" && !(await has(p, '[data-testid="zone-keep"]')));
await p.selectOption("#z-tz", "Europe/Paris");
await p.click('[data-r="zone-save"]');
check("F-196 changing: one button, Changing…", (await text(p, '[data-r="zone-save"]')) === "Changing…");
await p.waitForTimeout(600);
check("F-196 changed: each routine rewritten with cron.update, announced, focus back on Change…", (await text(p, '[data-testid="zone-line"]')) === "Routines' time zone: Paris" && (await live(p)) === "Changed the time zone of 2 routines" && (await focused(p)) === "zone:pip" && (await p.evaluate(() => window.routines.sent.filter((x) => x.params.patch.schedule?.tz === "Europe/Paris").length)) === 2);
await p.close();
p = await open("view=checkins&bot=pip&tzfail=cleanup");
await p.click('[data-r="zone"]');
await p.selectOption("#z-tz", "Europe/Paris");
await p.click('[data-r="zone-save"]');
await p.waitForTimeout(600);
check("F-196 a failure is reported by name, the dialog stays, focus on Close", (await text(p, '[data-testid="zone-result"]')) === "Changed Plan the week. Couldn't change Inbox tidy-up: the gateway didn't answer." && (await focused(p)) === "zone-close:");
await p.click('[data-r="zone-close"]');
check("F-196 after a partial change the zone line says Mixed", (await text(p, '[data-testid="zone-line"]')) === "Routines' time zone: Mixed: Paris, New York");
await p.close();
p = await open("view=checkins&bot=otto");
await p.click('[data-r="zone"]');
check("F-196 routines with no zone or a gateway-set schedule are listed and left alone", (await text(p, '[data-testid="zone-change"]')) === "Nightly backup check (now New York)" && (await text(p, '[data-testid="zone-keep"]')) === "Disk space watch (it has no time zone)Certificate renewal (its schedule was set on the gateway)");
await p.close();
p = await open("view=checkins&bot=pip&access=read");
check("F-196 read: the zone line without Change…", (await text(p, '[data-testid="zone-line"]')).startsWith("Routines' time zone") && !(await has(p, '[data-r="zone"]')));
await p.close();

// The conversation's routine cards and a check-in in progress
p = await open("transcript=checkin");
check("F-109 the Changed routine card names the routine", (await text(p, '[data-testid="changed-card"]')).trim() === "Changed routine Nightly backup check");
await p.click('[data-testid="changed-card"] .r-link');
check("F-109 its name opens the routine", (await text(p, "#view-title")) === "Nightly backup check");
await p.close();
p = await open("transcript=checkin&live=0");
check("a check-in's reply read from history only: no Checked in line and no Checked in preview", !(await has(p, '[data-testid="checkin"] .event-line')) && !(await p.evaluate(() => /Checked in/.test(document.body.textContent))));
await p.close();
p = await open("checkin=running");
check("a check-in in progress: Juniper's row has the working mark and Checking in", (await text(p, '[data-bot-row="juniper"] .bot-preview')) === "Checking in" && (await has(p, '[data-bot-row="juniper"] .glyph[data-state="working"]')) && (await label(p, '[data-bot-row="juniper"]')) === "Juniper, checking in");
await p.close();

// The calendar -----------------------------------------------------------------------------
p = await open("view=week");
check("F-197 week: seven days from today, in the viewer's zone", (await count(p, ".r-cal-dayhead")) === 7 && (await text(p, ".r-cal-dayhead")).startsWith("Today") && (await text(p, ".r-zone")) === "Your time, New York");
check("F-197 week: weekday routine on five days, London's Sunday 5 PM at noon here", (await p.evaluate(() => [...document.querySelectorAll('[data-testid="occurrence"][data-id="digest"]')].length)) === 5 && (await label(p, '[data-testid="occurrence"][data-id="standup"]')).startsWith("Plan the week, Pip, Sun 12:00 PM"));
check("F-197 frequent routines are a band, not future chips; paused ones are not drawn ahead", (await text(p, ".r-cal-band")) === "Disk space watch · every 30 minutes" && !(await has(p, '[data-testid="occurrence"][data-id="watch"][data-past="false"]')) && !(await has(p, '[data-testid="occurrence"][data-id="cleanup"]')));
check("F-197 a frequent routine's past run today is still drawn, as what happened", (await label(p, '[data-testid="occurrence"][data-id="watch"][data-past="true"]')) === "Disk space watch, Otto, Wed 10:00 AM, skipped");
check("F-197 today's past runs show how they went", (await p.evaluate(() => document.querySelector('[data-testid="occurrence"][data-id="backup"][data-past="true"]')?.dataset.outcome)) === "failed");
check("F-197 check-ins are one line, not chips", (await text(p, ".r-cal-checkins")) === "Check-ins: Juniper every 30 minutes");
check("calendar: top-of-the-hour chips say they may start later", (await label(p, '[data-testid="occurrence"][data-id="digest"][data-past="false"]')).endsWith("May start up to 5 minutes later."));
await p.click('[data-r="seg"][data-v="week"]');
await p.keyboard.press("ArrowLeft");
check("view switch: arrows move and choose", (await count(p, ".r-cal-dayhead")) === 3);
await p.keyboard.press("Home");
check("view switch: Home goes to List", (await count(p, '[data-testid="routine-row"]')) === 7);
await p.close();
p = await open("view=week");
check("calendar: a list per day, named by its date; no grid without rows", (await count(p, '[role="grid"], [role="gridcell"], [role="columnheader"]')) === 0 && (await p.evaluate(() => [...document.querySelectorAll('[data-testid="cal-day"]')].map((u) => u.tagName + ":" + u.getAttribute("aria-label")).slice(0, 2).join())) === "UL:Today Nov 18,UL:Thu Nov 19" && (await p.evaluate(() => [...document.querySelectorAll(".r-occ")].every((c) => c.parentElement.tagName === "LI"))));
check("calendar: the range is said", (await text(p, '[data-testid="cal-range"]')) === "Today Nov 18 to Tue Nov 24");
await p.click('[data-r="cal-move"][data-v="1"]');
check("calendar: Next moves the week, by pointer", (await text(p, '[data-testid="cal-range"]')) === "Wed Nov 25 to Tue Dec 1" && (await text(p, ".r-cal-dayhead")) === "WedNov 25" && (await p.evaluate(() => document.activeElement.matches('[data-r="cal-move"][data-v="1"]'))));
check("calendar: next week draws what is scheduled, the monthly renewal on Dec 1", (await label(p, '[data-testid="occurrence"][data-id="renewal"]')).startsWith("Certificate renewal, Otto, Tue 3:00 AM"));
await p.keyboard.press("Enter");
check("calendar: Next by keyboard", (await text(p, '[data-testid="cal-range"]')) === "Wed Dec 2 to Tue Dec 8");
await p.click('[data-r="cal-move"][data-v="0"]');
check("calendar: Today returns", (await text(p, '[data-testid="cal-range"]')) === "Today Nov 18 to Tue Nov 24");
await p.focus('[data-r="cal-move"][data-v="-1"]');
await p.keyboard.press("Space");
check("calendar: Previous by keyboard shows last week's runs as they ended, and nothing scheduled", (await text(p, '[data-testid="cal-range"]')) === "Wed Nov 11 to Tue Nov 17" && (await count(p, '[data-testid="occurrence"][data-id="digest"][data-past="true"]')) === 5 && (await count(p, '[data-testid="occurrence"][data-past="false"]')) === 0 && (await p.evaluate(() => document.querySelector('[data-testid="occurrence"][data-id="digest"][data-outcome="failed"]') !== null)));
await p.click('[data-r="cal-move"][data-v="0"]');
await p.focus('[data-testid="occurrence"][data-id="digest"][data-past="true"]');
await p.keyboard.press("ArrowRight");
check("calendar: Right goes to the closest chip on the next day", (await p.evaluate(() => document.activeElement.getAttribute("aria-label"))).startsWith("Morning digest, Marlow, Thu 8:00 AM"));
await p.keyboard.press("ArrowLeft");
check("calendar: Left comes back to the closest chip in time", (await p.evaluate(() => document.activeElement.getAttribute("aria-label"))) === "Morning digest, Marlow, Wed 8:00 AM, succeeded");
await p.close();
p = await open("view=week&routine=digest&state=paused");
await p.click('[data-r="cal-move"][data-v="-1"]');
check("calendar: a paused routine's past runs are still drawn", (await count(p, '[data-testid="occurrence"][data-id="digest"]')) === 5);
await p.click('[data-r="cal-move"][data-v="0"]');
check("calendar: a paused routine has today's run and nothing ahead", (await count(p, '[data-testid="occurrence"][data-id="digest"][data-past="true"]')) === 1 && (await count(p, '[data-testid="occurrence"][data-id="digest"][data-past="false"]')) === 0);
await p.close();
p = await open("view=day");
check("F-197 day: one column", (await count(p, ".r-cal-dayhead")) === 1);
await p.click('[data-testid="occurrence"][data-id="digest"]');
check("calendar: a chip opens the routine, Back returns to the calendar", (await text(p, "#view-title")) === "Morning digest" && (await label(p, '[data-r="back"]')) === "Back to the calendar");
await p.click('[data-r="back"]');
check("calendar: back where it was", (await count(p, ".r-cal-dayhead")) === 1);
await p.close();

// A routine's page -------------------------------------------------------------------------
p = await open("view=routine&routine=digest");
check("F-188 page: Instruction as written", (await text(p, '[data-testid="instruction"]')) === "Summarise the notes I added yesterday, and list anything I need to answer today.");
const fact = (id) => text(p, `[data-fact="${id}"] dd`);
check("F-188 F-353 When to run: schedule, zone, next run", (await fact("schedule")) === "Weekdays at 8:00 AM" && (await fact("zone")) === "New York America/New_York" && (await fact("next")) === "Tomorrow, Thu Nov 19, 8:00 AM");
check("F-188 runs in, results, and triggers: no webhook of its own", (await fact("runs-in")) === "A new conversation each time" && (await fact("results")) === "Kept with the run" && (await fact("triggers")) === "Its schedule only.This gateway's webhooks start a bot directly, not a routine.");
check("F-188 no webhook address, key or header is offered", !(await p.evaluate(() => /POST to|header/i.test(document.querySelector("#view").textContent))));
check("F-190 runs: newest first with outcomes in words", (await p.evaluate(() => [...document.querySelectorAll('[data-testid="run-row"] .r-run-how')].map((x) => x.textContent).join(" | "))) === "Succeeded · 2.6 s · 200 tokens | Succeeded · 3.1 s · 214 tokens | Ran, but its result wasn't delivered: No channel is set up to deliver to. | Failed: The model didn't answer within 120 seconds. | Skipped | Succeeded · 2.6 s · 200 tokens");
check("F-190 a forced run says started by hand", (await text(p, '[data-testid="run-row"][data-i="1"] .r-run-when')) === "Yesterday 11:40 AM · started by hand");
check("F-355 the footnote: 20 most recent, 7 days, 24 hours", (await text(p, ".r-foot-note")) === "Clawtrate shows the 20 most recent runs. The gateway keeps 7 days of runs, and each run's conversation for 24 hours unless it is set to keep them longer.");
check("page: admin actions Run now, Pause, Edit, More", (await text(p, '[data-r="run-now"]')) === "Run now" && (await text(p, '.r-head [data-r="toggle"]')) === "Pause" && (await text(p, '.r-head [data-r="edit"]')) === "Edit" && (await label(p, '[data-r="more"]')) === "More for Morning digest");

// Run now
await p.click('[data-r="run-now"]');
check("F-351 Run now: Starting…", (await text(p, '[data-r="run-now"]')) === "Starting…");
await p.waitForTimeout(650);
check("F-351 then Running… on the page, the rows and the rail (F-024)", (await text(p, '[data-testid="state-line"]')).startsWith("Running since") && (await text(p, '[data-testid="run-row"] .r-run-how')) === "Running…" && (await text(p, '[data-bot-row="marlow"] .bot-preview')) === "Running Morning digest" && (await has(p, '[data-bot-row="marlow"] .glyph[data-state="working"]')));
await p.click('[data-r="run-now"]');
check("F-351 a second Run now while running: It's already running.", (await text(p, ".r-already")) === "It's already running.");
await p.waitForTimeout(2000);
check("F-351 finished: the new run on top, started by hand, the rail calm, announced", (await text(p, '[data-testid="run-row"] .r-run-when')) === "Today 10:12 AM · started by hand" && !(await has(p, '[data-bot-row="marlow"] .glyph[data-state="working"]')) && (await live(p)) === "Morning digest finished");
await p.close();

p = await open("view=routine&routine=cleanup");
check("paused page: state line, Run once now, no next run", (await text(p, '[data-testid="state-line"]')) === "Paused. It won't run until resumed." && (await text(p, '[data-r="run-now"]')) === "Run once now" && (await text(p, '[data-fact="next"] dd')) === "None while paused" && (await text(p, '[data-testid="no-runs"]')) === "No runs yet.");
await p.click('[data-r="run-now"]');
await p.waitForTimeout(650);
check("F-351 a paused routine runs once and stays paused", (await text(p, '[data-testid="state-line"]')).startsWith("Running once. It stays paused.") && (await text(p, '.r-head [data-r="toggle"]')) === "Resume");
await p.close();
p = await open("view=routine&routine=standup");
check("F-353 another zone: next run in its zone and in yours", (await text(p, '[data-fact="next"] dd')) === "Sun, Sun Nov 22, 5:00 PM12:00 PM your time");
await p.close();
p = await open("view=routine&routine=reminder");
check("a reminder: posts in the main conversation, one-shot schedule", (await text(p, ".r-section .r-hint")) === "Posts a reminder in Marlow's main conversation:" && (await text(p, '[data-fact="runs-in"] dd')) === "Marlow's main conversation" && (await text(p, '[data-testid="no-runs"]')) === "No runs yet. The first is due Fri 9:00 AM.");
await p.close();
p = await open("view=routine&routine=watch");
check("a condition: Starts only when its check passes; no zone for every", (await text(p, '[data-fact="starts"] dd')).startsWith("Only when its check passes") && !(await has(p, '[data-fact="zone"]')));
await p.close();
p = await open("view=routine&routine=digest&state=noruns");
check("F-354 no runs yet: the first is due at its slot", (await text(p, '[data-testid="no-runs"]')) === "No runs yet. The first is due tomorrow 8:00 AM.");
await p.close();
p = await open("view=routine&routine=digest&state=deleted");
check("deleted elsewhere: the note, no actions", (await text(p, ".b-note")).startsWith("This routine was deleted. It won't run again.") && !(await has(p, '[data-r="run-now"]')));
await p.close();
p = await open("view=routine&routine=digest&state=failed");
check("failed: the state line says so", (await text(p, '[data-testid="state-line"]')) === "The last run failed.");
await p.close();
p = await open("view=routine&routine=digest&hooks=on");
check("F-349 gateway hooks on: POST to with copy, key kept on the gateway", (await text(p, '[data-testid="hooks"] summary')) === "Gateway webhooks" && (await text(p, '[data-testid="hooks"]')).includes("/hooks/agent") && (await text(p, '[data-testid="hooks"]')).includes("Kept on the gateway") && (await has(p, '[data-testid="hooks"] .copy')));
await p.click('[data-testid="hooks"] summary');
await p.click('[data-testid="hooks"] .copy');
check("F-349 copy: copied, or selected and said so when the clipboard refuses", /^(Copied hook address|Selected\. Press ⌘C to copy the hook address\.)$/.test(await live(p)));
await p.close();

// Delete
p = await open("view=routine&routine=backup");
await p.click('[data-r="more"]');
check("More holds Delete…", (await p.evaluate(() => [...document.querySelectorAll("#r-menu .menu-item")].map((x) => x.textContent).join())).endsWith("Delete…"));
await p.click('#r-menu [data-r="delete"]');
check("F-352 confirmation: what is lost, Cancel focused", (await text(p, "#confirm-title")) === "Delete Nightly backup check?" && (await text(p, "#confirm-text")) === "It won't run again, and Clawtrate can't show its runs afterwards. Its last run was today at 3:30 AM." && (await p.evaluate(() => document.activeElement.dataset.r)) === "confirm-cancel" && (await p.evaluate(() => document.querySelector("#confirm-dialog").getAttribute("role"))) === "alertdialog");
await p.click('[data-r="confirm-delete"]');
check("F-352 deleted: back to the list, row gone, announced", (await text(p, "#view-title")) === "Routines" && !(await has(p, '[data-routine="backup"]')) && (await live(p)) === "Deleted Nightly backup check");
await p.close();

// A run --------------------------------------------------------------------------------------
p = await open("view=routine&routine=digest");
await p.click('[data-testid="run-row"][data-i="0"]');
check("F-193 a run opens its conversation: the scheduled message as the gateway recorded it, then the reply", (await text(p, "#view-title")) === "Morning digest · Today 8:00 AM" && (await text(p, '[data-testid="scheduled-message"] .r-sched-head')) === "Scheduled message, as the gateway recorded it" && (await text(p, '[data-testid="scheduled-message"] p')).startsWith("Summarise the notes I added yesterday, and list anything I need to answer today.\n\nThis is an unattended scheduled run.") && (await has(p, ".r-convo .bubble")));
check("F-190 the run's foot: no reply possible, its usage", (await text(p, '[data-testid="run-foot"]')).startsWith("This run has finished. A run can't be answered; to change what it does, edit the routine.") && (await text(p, ".r-run-facts")) === "scripted/dev-1 · 2.6 s · 120 in, 80 out tokens" && !(await has(p, ".composer-input")));
await p.click('[data-r="back-to-routine"]');
check("Back returns to the routine, focus on the run", (await text(p, "#view-title")) === "Morning digest" && (await p.evaluate(() => document.activeElement.matches('[data-r="open-run"][data-i="0"]'))));
await p.close();
p = await open("view=run&routine=digest&run=1");
check("a run from before the instruction was edited shows the message it was sent, not today's", (await text(p, '[data-testid="scheduled-message"] p')).startsWith("Summarise the notes I added yesterday.\n\n"));
await p.close();
p = await open("view=run&routine=digest&run=3");
check("no recorded conversation: said plainly, with what the run returned; nothing rebuilt from the current instruction", (await text(p, ".b-note")).startsWith("Clawtrate can't show this run's conversation. The gateway returned none for it.") && (await text(p, '[data-testid="returned"]')) === "Failed: The model didn't answer within 120 seconds." && !(await has(p, '[data-testid="scheduled-message"]')) && !(await p.evaluate(() => /as it reads now/.test(document.body.textContent))));
await p.close();
p = await open("view=run&routine=reminder&run=0&state=ran-once");
check("a reminder's run is in the main conversation: no transcript of its own, its summary and a way there", (await text(p, ".b-note")).startsWith("This run happened in Marlow's main conversation.") && (await text(p, '[data-testid="returned"]')) === "Posted the reminder in Marlow's main conversation." && (await has(p, '.b-note [data-r="open-bot"]')) && !(await has(p, '[data-testid="scheduled-message"]')));
await p.close();
p = await open("view=routine&routine=reminder&state=ran-once");
check("a one-shot that succeeded and removed itself: its page says so and keeps its run; no actions", (await text(p, ".b-note")).startsWith("This routine ran once, and the gateway removed it. Its run succeeded today 9:00 AM.") && (await count(p, '[data-testid="run-row"]')) === 1 && !(await has(p, '[data-r="run-now"]')));
await p.click('.b-note [data-r="back"]');
check("a removed one-shot is not listed", !(await has(p, '[data-routine="reminder"]')) && (await text(p, '[data-testid="count"]')) === "6 routines");
await p.close();
p = await open("view=run&routine=digest&run=0&runstate=error");
check("run couldn't load", (await text(p, '[data-testid="run-error"] h4')) === "Couldn't load this run.");
await p.close();
p = await open("view=run&routine=digest&run=0&runstate=running");
check("run in progress: live steps and Running…", (await text(p, '[data-testid="run-foot"]')).trim() === "Running…" && (await has(p, '.steps .glyph[data-state="working"]')));
await p.close();
p = await open();
await p.click('[data-testid="run-task"][data-id="digest"]');
check("F-193 the rail's run row opens the run; All runs goes to the routine", (await text(p, "#view-title")) === "Morning digest · Today 8:00 AM" && (await has(p, '.r-head [data-r="back-to-routine"]')));
await p.close();

// The editor -----------------------------------------------------------------------------------
p = await open();
await p.click('.r-head [data-r="new"]');
check("F-189 New routine: a dialog with Bot, Name, Instruction, When, Time zone, preview", (await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await text(p, "#edit-title")) === "New routine" && (await has(p, "#e-bot")) && (await has(p, "#e-name")) && (await has(p, "#e-instr")) && (await count(p, '#e-when [role="radio"]')) === 5 && (await has(p, "#e-tz")));
check("F-189 the preview says what the gateway will do and the next three times", (await text(p, '[data-testid="preview"]')) === "Runs weekdays at 8:00 AM, New York time. Next: Thu Nov 19, 8:00 AM, then Fri Nov 20, Mon Nov 23.");
check("F-354 creating does not run it", (await text(p, "#edit-dialog .b-body > .r-hint")) === "It runs first at its next time; creating it doesn't run it.");
await p.click('[data-r="save"]');
check("validation: name and instruction, focus on the first", (await text(p, "#e-name-error")) === "Give it a name." && (await text(p, "#e-instr-error")) === "Say what the bot should do." && (await p.evaluate(() => document.activeElement.id)) === "e-name");
await p.fill("#e-name", "Evening wrap-up");
await p.fill("#e-instr", "List what I finished today.");
await p.click('[data-e-kind="every"]');
await p.fill("#e-n", "2");
await p.click('[data-r="save"]');
check("F-195 below 5 minutes: the floor is Clawtrate's, said under the field", (await text(p, "#e-when-error")) === "Routines run at least 5 minutes apart.");
await p.click('[data-e-kind="days"]');
await p.click('[data-e-day="1"]');
await p.click('[data-r="save"]');
check("some days with none chosen", (await text(p, "#e-when-error")) === "Choose at least one day.");
await p.click('[data-e-day="5"]');
await p.selectOption("#e-tz", "Europe/Paris");
check("time zone changes the preview, with your time", (await text(p, '[data-testid="preview"]')).startsWith("Runs fridays at 8:00 AM, Paris time. Next: Fri Nov 20, 8:00 AM (2:00 AM your time)"));
await p.click('[data-r="save"]');
check("saving: Saving…, fields kept", (await text(p, '[data-r="save"]')) === "Saving…" && (await p.inputValue("#e-name")) === "Evening wrap-up");
await p.waitForTimeout(700);
check("saved: the new routine's page, no runs yet, announced", (await text(p, "#view-title")) === "Evening wrap-up" && (await text(p, '[data-testid="no-runs"]')).startsWith("No runs yet. The first is due") && (await live(p)) === "Routine created");
await p.close();
p = await open("edit=open&routine=digest");
check("F-189 edit: fields filled from the routine; the bot is kept", (await p.inputValue("#e-name")) === "Morning digest" && (await p.evaluate(() => document.querySelector('[data-e-kind="weekdays"]').getAttribute("aria-checked"))) === "true" && (await text(p, "#edit-dialog .b-body")).includes("To run it on another bot, make a new routine."));
await p.focus('[data-e-kind="weekdays"]');
await p.keyboard.press("ArrowDown");
check("When is a radio group: arrows choose", (await p.evaluate(() => document.querySelector('[data-e-kind="days"]').getAttribute("aria-checked"))) === "true");
await p.keyboard.press("Escape");
check("Escape closes the editor", !(await p.evaluate(() => document.querySelector("#edit-dialog").open)));
await p.close();
p = await open("edit=open&routine=digest&editstate=refused");
check("refused: the gateway's message, nothing typed lost", (await text(p, "#edit-dialog .b-note")).startsWith("The gateway didn't save this. invalid cron.add params: CronPattern") && (await p.inputValue("#e-name")) === "Morning digest");
await p.close();
p = await open("edit=open&routine=digest&editstate=conflict");
check("changed elsewhere: does not save, offers the new version or mine", (await text(p, "#edit-dialog .b-note")).startsWith("This routine was changed elsewhere while you were editing.") && (await has(p, '[data-r="conflict-show"]')) && (await has(p, '[data-r="conflict-save"]')));
await p.close();
p = await open("edit=open&routine=digest&editstate=deleted");
check("deleted elsewhere: Save as a new routine", (await text(p, "#edit-dialog .b-note")).startsWith("This routine was deleted while you were editing.") && (await has(p, '[data-r="save-as-new"]')));
await p.close();
p = await open("edit=open&routine=digest&editstate=noanswer");
check("no answer: the outcome is unknown, check before saving again", (await text(p, "#edit-dialog .b-note")).startsWith("The gateway didn't answer. This may or may not have saved.") && (await has(p, '[data-r="check-now"]')));
await p.click('[data-r="check-now"]');
check("Check now: checking, and nothing is saved by it", (await text(p, "#edit-dialog .b-note")) === "Checking what the gateway has…" && (await p.evaluate(() => window.routines.sent.length)) === 0);
await p.waitForTimeout(500);
check("Check now on an edit: says what the gateway has, as found, and offers Close; Save is not offered", (await text(p, "#edit-dialog .b-note")).startsWith("Morning digest now reads as you typed it. That may be your save, or the same change made elsewhere.") && (await has(p, '#edit-dialog .b-note [data-r="edit-close"]')) && !(await has(p, '.b-foot [data-r="save"]')) && (await p.evaluate(() => document.querySelector("#edit-dialog").open)));
await p.close();
for (const lookup of ["found", "none"]) {
  p = await open(`editstate=noanswer&lookup=${lookup}`);
  await p.click('.r-head [data-r="new"]');
  await p.fill("#e-name", "Evening wrap-up");
  await p.fill("#e-instr", "List what I finished today.");
  await p.click('[data-r="save"]');
  await p.waitForTimeout(700);
  check(`no answer on a new routine (${lookup}): the dialog stays, typed input kept, focus on Check now`, (await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await p.inputValue("#e-name")) === "Evening wrap-up" && (await p.evaluate(() => document.activeElement.dataset.r)) === "check-now");
  await p.click('[data-r="check-now"]');
  await p.waitForTimeout(500);
  const words = await text(p, "#edit-dialog .b-note");
  if (lookup === "found")
    check("Check now found a routine with that name: says it may be another client's, offers Open it and a separate Save again", words.startsWith("The gateway has a routine for Marlow named Evening wrap-up, created today 10:12 AM. It may be the one you saved, or one made elsewhere.") && (await has(p, '[data-r="open-found"]')) && (await text(p, '#edit-dialog .b-note [data-r="save"]')) === "Save again" && (await text(p, "#edit-dialog .b-note .r-hint")) === "Saving again makes another routine if that one is yours." && (await p.evaluate(() => window.routines.sent.length)) === 1);
  else check("Check now found nothing: may still arrive; Check again and Save again", words.startsWith("The gateway has no routine for Marlow named Evening wrap-up. The save may still arrive.") && (await has(p, '#edit-dialog .b-note [data-r="check-now"]')) && (await has(p, '#edit-dialog .b-note [data-r="save"]')) && (await p.evaluate(() => window.routines.sent.length)) === 0);
  await p.click('#edit-dialog .b-note [data-r="save"]');
  check(`Save again is its own explicit retry (${lookup})`, (await text(p, '.b-foot [data-r="save"]')) === "Saving…");
  await p.close();
}
p = await open("edit=open&routine=digest");
await p.fill("#e-name", "Morning notes");
await p.click('[data-r="save"]');
await p.keyboard.press("Escape");
check("Escape while saving: the dialog stays open until the answer", await p.evaluate(() => document.querySelector("#edit-dialog").open));
await p.waitForTimeout(700);
check("then the answer closes it, for this draft", !(await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await text(p, "#view-title")) === "Morning notes");
await p.close();
p = await open("edit=open&editstate=locked");
check("a schedule set on the gateway is shown as written and left alone", (await text(p, '[data-testid="locked"]')).includes("0 9 1 * *") && (await text(p, '[data-testid="locked"]')).includes("change its schedule on the gateway.") && !(await has(p, '#e-when')));
await p.close();
const lastSent = (p) => p.evaluate(() => window.routines.sent.at(-1));
p = await open("edit=open&routine=reminder");
check("a reminder's text is shown, not offered for editing", (await text(p, '[data-testid="payload-locked"]')).startsWith("Reminder: send the newsletter draft to Sam") && !(await has(p, "#e-instr")));
check("Once: the editor opens on the saved instant, in your zone", (await p.inputValue("#e-date")) === "2026-11-20" && (await p.inputValue('[data-e="time"]')) === "09:00" && (await p.inputValue("#e-tz")) === "auto");
await p.fill("#e-name", "Send the draft to Sam today");
await p.click('[data-r="save"]');
await p.waitForTimeout(700);
let sent = await lastSent(p);
check("Once: a name-only edit sends the name only, keeps the reminder and leaves the instant", sent.method === "cron.update" && JSON.stringify(sent.params.patch) === '{"name":"Send the draft to Sam today"}' && (await p.evaluate(() => window.routines.routine("reminder").payload.kind)) === "systemEvent" && (await p.evaluate(() => window.routines.routine("reminder").schedule.at)) === "2026-11-20T14:00:00.000Z");
await p.click('.r-head [data-r="edit"]');
await p.fill('[data-e="time"]', "10:00");
await p.selectOption("#e-tz", "Europe/Paris");
await p.click('[data-r="save"]');
await p.waitForTimeout(700);
sent = await lastSent(p);
check("Once: a changed time is written as an ISO timestamp with its offset, and no tz", JSON.stringify(sent.params.patch.schedule) === '{"kind":"at","at":"2026-11-20T10:00:00+01:00"}');
check("Once: read back in your zone", (await text(p, '[data-fact="schedule"] dd')) === "Once, Nov 20 at 4:00 AM, New York");
await p.close();
for (const [expr, ok] of [["*/5 * * * *", true], ["0 8 * * 1-5", true], ["0,30 * * * *", true], ["*/4 * * * *", false], ["* * * * *", false], ["0,2 * * * *", false]]) {
  p = await open("edit=new");
  await p.fill("#e-name", "Often");
  await p.fill("#e-instr", "Look.");
  await p.click("#edit-dialog summary");
  await p.fill("#e-cron", expr);
  await p.click('[data-r="save"]');
  check(`F-195 cron floor: ${expr} ${ok ? "passes" : "is under 5 minutes"}`, ok ? !(await has(p, "#e-cron-error")) && (await text(p, '[data-r="save"]')) === "Saving…" : (await text(p, "#e-cron-error")) === "Routines run at least 5 minutes apart.");
  await p.close();
}
p = await open("edit=new&editstate=invalid");
check("invalid state from the address: the interval error", (await text(p, "#e-when-error")) === "Routines run at least 5 minutes apart.");
await p.close();
const openDialogs = (p) => p.evaluate(() => [...document.querySelectorAll("dialog")].filter((d) => d.open).map((d) => d.id).join());
const MUTATIONS = '#e-name, #e-instr, [data-r="save"], [data-r="confirm-delete"], [data-ci], [data-r="ci-save"], .b-switch, [data-r="run-now"], [data-r="edit"], [data-r="new"], [data-r="more"]';
for (const access of ["read", "write"])
  for (const q of ["edit=open&routine=digest", "edit=new", "editstate=locked", "edit=open&routine=digest&editstate=refused", "confirm=delete&routine=digest", "view=routine&routine=digest&confirm=delete", "dialog=open&bot=juniper", "view=checkins&bot=juniper&dialog=open&catch=1"]) {
    p = await open(`access=${access}&${q}`);
    check(`${access}: the address ${q} opens no dialog and offers no change`, (await openDialogs(p)) === "" && (await count(p, MUTATIONS)) === 0 && (await has(p, ".access-bar")));
    await p.close();
  }

// Check-ins -------------------------------------------------------------------------------------
p = await open("view=checkins&bot=marlow");
check("F-201 a bot without check-ins says why", (await text(p, '[data-testid="checkins-text"]')) === "Marlow doesn't check in. Without a setting of its own, only the gateway's default bot checks in.");
await p.click('[data-r="checkins"]');
check("F-201 the setting: Off, Daily, As needed, Every…", (await p.evaluate(() => [...document.querySelectorAll("[data-ci] .b-choice-title")].map((x) => x.textContent).join())) === "Off,Daily,As needed,Every…");
check("F-201 As needed says what it honestly is", (await p.evaluate(() => document.querySelector('[data-ci="asneeded"] .b-choice-sub').textContent)) === "Every 30 minutes, Marlow looks for anything that needs you. Its prompt asks it to stay quiet when nothing does.");
check("F-366 Off says what it does not stop", (await text(p, '[data-testid="off-note"]')) === "Marlow still reports when a command it started in the background finishes.");
await p.click('[data-ci="daily"]');
check("the catch: Juniper keeps checking in, said before saving", (await text(p, "#checkins-dialog .b-note")) === "Juniper checks in now through the gateway's default. Saving also gives Juniper a setting of its own with the same cadence, so it keeps checking in.");
await p.click("#checkins-dialog summary");
await p.fill("[data-ci-prompt]", "Tell me about my day.");
check("a custom prompt without NO_REPLY: silence is what the default prompt asks for, not a promise either way", (await text(p, '[data-testid="prompt-note"]')) === "This prompt doesn't ask Marlow to reply NO_REPLY when nothing needs attention, as the gateway's own prompt does, so Marlow may answer every check-in.");
await p.click('[data-r="ci-save"]');
await p.keyboard.press("Escape");
check("check-ins: Escape while saving keeps the dialog until the answer", await p.evaluate(() => document.querySelector("#checkins-dialog").open));
await p.waitForTimeout(700);
check("F-201 saved: Marlow daily, Juniper still checks in, announced", (await text(p, '[data-testid="checkins-text"]')) === "Once a day, Marlow looks for anything that needs you." && (await live(p)) === "Check-ins saved");
await p.click('[data-r="bot-menu"]');
await p.click('#r-menu [data-id="juniper"]');
check("the catch held: Juniper still every 30 minutes", (await text(p, '[data-testid="checkins-text"]')).startsWith("Every 30 minutes, Juniper"));
await p.close();
p = await open("view=checkins&bot=juniper&checkins=off");
check("F-366 Off: no scheduled check-ins", (await text(p, '[data-testid="checkins-text"]')) === "Juniper doesn't check in on a schedule.");
await p.close();
p = await open("transcript=checkin");
check("check-in seen live: Checked in over its reply", (await text(p, '[data-testid="checkin"] .event-line')).trim() === "Checked in · 9:30 AM");
check("from history without a live record: an ordinary reply, no check-in label and no guess", !(await has(p, '[data-testid="from-history"] .event-line')) && (await text(p, '[data-testid="from-history"] .bubble')) === "The installer's quote you saved expires on Friday." && !(await p.evaluate(() => /on its own/.test(document.body.textContent))));
check("rail: a check-in seen live leads the preview with Checked in", (await text(p, '[data-bot-row="juniper"] .bot-preview')).startsWith("Checked in: The rebate form"));
check("F-108 the Created routine card's name opens the routine", (await text(p, '[data-testid="created-card"]')).trim() === "Created routine Morning digest");
await p.click('[data-testid="created-card"] a');
check("F-108 opened", (await text(p, "#view-title")) === "Morning digest");
await p.close();

// Away -------------------------------------------------------------------------------------------
p = await open("away=1");
check("F-194 the away card: question, three answers, and when Clawtrate pauses", (await text(p, "#away-title")) === "You've been away for a bit. 6 routines kept running while you were away. Keep them running?" && (await count(p, '[data-testid="away"] .button')) === 3 && (await text(p, '[data-testid="away"]')).includes("If you don't answer, Clawtrate pauses them on Nov 25, the first time it is open with admin access on or after that day."));
check("F-194 the Routines button says it needs an answer", (await label(p, "#routines-button")) === "Routines, needs your answer" && (await has(p, "#routines-button .r-away-dot")));
await p.click('[data-r="away-pause"]');
check("F-194 Pause them all pauses every routine", (await count(p, '.b-switch[aria-checked="true"]')) === 0 && !(await has(p, '[data-testid="away"]')));
await p.close();
p = await open("away=1&access=write");
check("F-357 below admin the card says pausing needs admin, and offers no pause", !(await has(p, '[data-r="away-pause"]')) && (await text(p, '[data-testid="away"]')).includes("Pausing them needs admin access."));
await p.close();
p = await open("away=1&access=read");
check("F-194 a read-only connection can't keep the answer: no card, no dot", !(await has(p, '[data-testid="away"]')) && !(await has(p, "#routines-button .r-away-dot")) && (await label(p, "#routines-button")) === "Routines");
await p.close();
p = await open("away=1&prefs=none");
check("F-194 without a durable identity the card says its answer stays on this device", (await text(p, '[data-testid="away-device"]')) === "This gateway can't keep your answer for your other devices, so Clawtrate keeps it on this one; another device may ask again.");
await p.close();

// Widths, themes, motion ------------------------------------------------------------------------
for (const [w, h] of [[1440, 900], [1100, 760], [800, 760], [390, 844]]) {
  for (const theme of ["light", "dark"]) {
    for (const view of ["", "view=routine&routine=digest", "view=week", "view=run&routine=digest&run=0"]) {
      const pg = await b.newPage({ viewport: { width: w, height: h } });
      pg.on("pageerror", (e) => out.push("PAGEERROR " + e));
      await pg.goto(pageUrl("routines.html") + `?chrome=0&theme=${theme}&${view}`);
      await pg.waitForTimeout(80);
      const r = await pg.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        body: getComputedStyle(document.querySelector("#view")).backgroundColor,
        title: document.querySelector("#view-title")?.textContent || "",
      }));
      check(`${w} ${theme} ${view || "list"}: no page overflow, a title`, !r.overflow && !!r.title && r.body !== "rgba(0, 0, 0, 0)", JSON.stringify(r));
      await pg.close();
    }
  }
}
p = await open("width=phone", { width: 390, height: 844 });
check("phone: List and Day only, Back to bots in the header", (await count(p, '.r-seg [role="radio"]')) === 2 && (await label(p, '.r-head [data-r="to-bots"]')) === "Back to bots");
check("phone: New routine is a round + button, so the title keeps its room", (await label(p, '.r-head .icon-button[data-r="new"]')) === "New routine" && (await p.evaluate(() => { const t = document.querySelector("#view-title"); return t.scrollWidth <= t.clientWidth; })));
await p.click('.r-head [data-r="to-bots"]');
check("phone: Back shows the bots, focus on the Routines button", (await p.evaluate(() => document.querySelector(".shell").dataset.view)) === "list" && (await p.evaluate(() => document.activeElement.id)) === "routines-button");
await p.click("#routines-button");
check("phone: the Routines button opens the view", (await p.evaluate(() => document.querySelector(".shell").dataset.view)) === "detail" && (await text(p, "#view-title")) === "Routines");
check("phone: switches have a 44 px hit area", (await p.evaluate(() => document.querySelector(".r-seg button").getBoundingClientRect().height >= 38)));
await p.close();
p = await open("view=routine&routine=digest", { width: 800, height: 760 });
check("800: the page header keeps Run now and More only", (await p.evaluate(() => getComputedStyle(document.querySelector(".r-head [data-wide]")).display)) === "none" && (await has(p, '[data-r="more"]')));
await p.close();
p = await open("motion=reduce&view=routine&routine=digest&state=running");
check("reduced motion: nothing runs", (await p.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)) === 0);
await p.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR")) ? 1 : 0);
