// Behaviour checks for routines.html: the Routines view and its calendar, a
// routine's page and runs, a run's conversation, live changes, the editor,
// pause, run now, delete, the request for admin access, check-ins and the
// away card, at the four widths and in both themes.
// Run from the repository root:  node docs/design/prototype/tools/checks/routines.mjs
import { readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, pageUrl } from "./browser.mjs";
// The pinned gateway schema: every request a page sends is checked against it.
import { validateCronAddParams, validateCronGetParams, validateCronRemoveParams, validateCronUpdateParams } from "../../../../../packages/core/node_modules/@openclaw/gateway-protocol/dist/index.mjs";

const base = pageUrl("routines.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${extra}`);
};
// Every request a page put on the wire, answered or not, collected as it closes, for the schema check at the end.
const requests = [];
// The page's timers run on a paused fake clock that only a wait moves, so its simulated gateway answers
// in order even when the OS fires real timers late (#238). The real wait is for the browser's own work.
const wait = async (p, ms) => {
  await p.waitForTimeout(ms);
  await p.clock.runFor(ms);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  // Paused straight away: a clock installed first would run in real time, and a late pause would
  // then be in its past. One that pauseAt installs starts at zero, so pausing is always forward.
  await p.clock.pauseAt(new Date("2026-11-18T15:12:01Z"));
  await p.goto(base + (query ? "&" + query : ""));
  await wait(p, 150);
  const close = p.close.bind(p);
  p.close = async () => {
    for (const r of await p.evaluate(() => window.routines?.dispatched ?? [])) requests.push({ query, ...r });
    return close();
  };
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent || "", sel);
const has = (p, sel) => p.evaluate((s) => !!document.querySelector(s), sel);
const count = (p, sel) => p.evaluate((s) => document.querySelectorAll(s).length, sel);
const label = (p, sel) => p.evaluate((s) => document.querySelector(s)?.getAttribute("aria-label") || "", sel);
const live = (p) => wait(p, 80).then(() => text(p, "#r-announce"));

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
await wait(p, 700);
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
const event = (p, ev) => p.evaluate((e) => window.routines.event(e), ev).then(() => wait(p, 60));
const focused = (p) => p.evaluate(() => { const a = document.activeElement; return a.id || `${a.dataset.r}:${a.dataset.id || ""}`; });
const EVENING = { id: "evening", bot: "marlow", name: "Evening wrap-up", schedule: { kind: "cron", expr: "0 18 * * *", tz: "America/New_York" }, payload: { kind: "agentTurn", message: "List what I finished today." }, sessionTarget: "isolated", delivery: { mode: "none" }, updatedAtMs: 0 };
p = await open();
await p.focus('[data-routine="digest"] .b-switch');
await event(p, { action: "added", job: EVENING, nextRunAtMs: 0 });
check("event added: the row appears in its place, in words", (await text(p, '[data-routine="evening"] .r-row-line')) === "Every day at 6:00 PM, New York · Next today 6:00 PM · No runs yet" && (await text(p, '[data-testid="count"]')) === "8 routines");
check("event added: focus stays, and another client's routine is not announced", (await focused(p)) === "toggle:digest" && (await live(p)) === "");
await event(p, { action: "updated", job: { id: "digest", name: "Morning notes", schedule: { kind: "cron", expr: "30 7 * * 1-5", tz: "America/New_York" } } });
check("event updated: the row shows the new values, focus stays, nothing announced off screen", (await text(p, '[data-routine="digest"] .r-row-name')) === "Morning notes" && (await text(p, '[data-routine="digest"] .r-row-line')).startsWith("Weekdays at 7:30 AM, New York") && (await focused(p)) === "toggle:digest" && (await live(p)) === "");
await event(p, { action: "removed", jobId: "backup" });
check("event removed: the row leaves the list and the rail, focus stays", !(await has(p, '[data-routine="backup"]')) && !(await has(p, '[data-testid="run-task"][data-id="backup"]')) && (await text(p, '[data-testid="count"]')) === "7 routines" && (await focused(p)) === "toggle:digest");
await event(p, { action: "finished", jobId: "watch", runId: "w-1", runAtMs: Date.UTC(2026, 10, 18, 15, 12), status: "error", completionStatus: "failed", error: "The check script exited with 2.", durationMs: 300 });
check("event finished with a failure: announced wherever the person is; the row gets the failed mark", (await live(p)) === "Disk space watch failed" && (await has(p, '[data-routine="watch"] .glyph[data-state="failed"]')));
await event(p, { action: "updated", job: { id: "digest", state: { nextRunAtMs: Date.UTC(2026, 10, 20, 13, 0) } } });
check("event updated, state.nextRunAtMs only: the row's Next is the gateway's", (await text(p, '[data-routine="digest"] .r-row-line')).includes(" · Next Fri 8:00 AM · "));
await event(p, { action: "finished", jobId: "digest", runId: "d-1", runAtMs: Date.UTC(2026, 10, 18, 15, 12), status: "ok", nextRunAtMs: Date.UTC(2026, 10, 23, 13, 0) });
check("event finished: Next follows its nextRunAtMs", (await text(p, '[data-routine="digest"] .r-row-line')).includes(" · Next Mon 8:00 AM · "));
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
await wait(p, 650);
check("F-351 Run now refused: the reason under the button, Run now offered again, focus on it", (await text(p, '[data-testid="run-error-line"]')) === "Couldn't start a run: the gateway didn't answer." && (await text(p, '[data-r="run-now"]')) === "Run now" && (await focused(p)) === "run-now:digest" && !(await has(p, '[data-testid="state-line"] .glyph[data-state="working"]')));
await wait(p, 2200);
check("F-351 Run now refused: no run, then or later, the six runs as they were", (await count(p, '[data-testid="run-row"]')) === 6 && (await text(p, '[data-testid="run-row"] .r-run-when')) === "Today 8:00 AM" && (await p.evaluate(() => window.routines.routine("digest").runs.length)) === 6);
await p.close();
for (const outcome of ["1", "landed"]) {
  p = await open(`view=routine&routine=backup&deletefail=${outcome}&confirm=delete`);
  await p.click('[data-r="confirm-delete"]');
  await p.keyboard.press("Escape");
  check(`F-352 unanswered delete (${outcome}): outcome unknown, Check now focused, Cancel unavailable`, (await text(p, "#confirm-error")) === "The gateway didn't answer. This routine may have been deleted." && (await focused(p)) === "check-delete:backup" && !(await has(p, '[data-r="confirm-cancel"]')));
  await p.click('[data-r="check-delete"]');
  check("F-352 checking sends no second delete", (await p.evaluate(() => window.routines.dispatched.length)) === 1);
  if (outcome === "landed") {
    check("F-352 reply lost after deletion: absences are confirmed before returning to the list", (await text(p, "#view-title")) === "Routines" && !(await has(p, '[data-routine="backup"]')) && (await live(p)) === "Deleted Nightly backup check");
  } else {
    check("F-352 still listed: report the read and allow Cancel", (await text(p, "#confirm-error")) === "The gateway still lists this routine. The delete may still arrive.");
    await p.click('[data-r="confirm-cancel"]');
    check("F-352 confirmed present: Cancel returns to the routine", (await text(p, "#view-title")) === "Nightly backup check" && (await has(p, '[data-r="run-now"]')));
  }
  await p.close();
}
p = await open("edit=open&routine=digest&editstate=adminlost");
await p.fill("#e-name", "Morning notes");
await p.click('[data-r="save"]');
await wait(p, 700);
check("admin lost while saving: the access bar takes the foot, typed input kept, focus on the request", (await text(p, '[data-testid="editor-access"]')).startsWith("Admin access was lost. Saving needs it again. What you typed is kept.") && (await p.inputValue("#e-name")) === "Morning notes" && !(await has(p, '#edit-dialog [data-r="save"]')) && (await focused(p)) === "request:" && (await live(p)) === "Admin access was lost");
await p.click('#edit-dialog [data-r="request"]');
await wait(p, 700);
await p.click('#edit-dialog [data-r="access-check"]');
check("admin granted again: Save is back, with what was typed", (await has(p, '#edit-dialog [data-r="save"]')) && (await p.inputValue("#e-name")) === "Morning notes");
await p.click('#edit-dialog [data-r="save"]');
await wait(p, 700);
check("admin granted again: the save is sent once, lands and closes the dialog; the refusal was the first attempt's only", !(await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await text(p, "#view-title")) === "Morning notes" && JSON.stringify(await p.evaluate(() => window.routines.sent)) === JSON.stringify([{ method: "cron.update", params: { id: "digest", patch: { name: "Morning notes" } } }]) && (await live(p)) === "Saved");
await p.close();

// More than 20 runs (F-355)
p = await open("view=routine&routine=digest&runs=25");
const ats = await p.evaluate(() => [...document.querySelectorAll('[data-testid="run-row"]')].map((x) => +x.dataset.at));
const want = Array.from({ length: 20 }, (_, k) => Date.UTC(2026, 10, 18, 15, 0) - k * 6 * 3600e3);
check("F-355 with 25 runs the page shows the 20 most recent, newest first: exactly those twenty", JSON.stringify(ats) === JSON.stringify(want) && (await text(p, '[data-testid="run-row"] .r-run-when')) === "Today 10:00 AM");
await p.close();

// A bot's routines' time zone (F-196)
p = await open("view=checkins&bot=pip");
check("F-196 the zone line with Change…", (await text(p, '[data-testid="zone-line"]')) === "Routines' time zone: Mixed: London, New York" && (await has(p, '[data-r="zone"]')));
await p.click('[data-r="zone"]');
check("F-196 Change… lists what it will change", (await text(p, "#zone-title")) === "Pip's routines' time zone" && (await text(p, '[data-testid="zone-change"]')) === "Plan the week (now London)Inbox tidy-up (now New York)" && !(await has(p, '[data-testid="zone-keep"]')));
await p.selectOption("#z-tz", "Europe/Paris");
await p.click('[data-r="zone-save"]');
check("F-196 changing: one button, Changing…", (await text(p, '[data-r="zone-save"]')) === "Changing…");
await wait(p, 600);
check("F-196 changed: each routine rewritten with cron.update, announced, focus back on Change…", (await text(p, '[data-testid="zone-line"]')) === "Routines' time zone: Paris" && (await live(p)) === "Changed the time zone of 2 routines" && (await focused(p)) === "zone:pip" && (await p.evaluate(() => window.routines.sent.filter((x) => x.params.patch.schedule?.tz === "Europe/Paris").length)) === 2);
await p.close();
for (const lookup of ["unchanged", "found", "unavailable"]) {
  p = await open(`view=checkins&bot=pip&tzfail=cleanup&tzlookup=${lookup}`);
  await p.click('[data-r="zone"]');
  await p.selectOption("#z-tz", "Europe/Paris");
  await p.click('[data-r="zone-save"]');
  await wait(p, 600);
  check(`F-196 unanswered zone write (${lookup}): reads the routine once and sends no second write`, JSON.stringify(await p.evaluate(() => window.routines.dispatched.map((x) => [x.method, x.params.id]))) === JSON.stringify([["cron.update", "standup"], ["cron.update", "cleanup"], ["cron.get", "cleanup"]]));
  const line = await text(p, '[data-testid="zone-line"]');
  const result = await text(p, '[data-testid="zone-result"]');
  if (lookup === "found")
    check("F-196 reply lost after the change: the read confirms both changes", line === "Routines' time zone: Paris" && (await live(p)) === "Changed the time zone of 2 routines");
  else if (lookup === "unchanged")
    check("F-196 the gateway still lists the old zone: report the read and keep the dialog open", line === "Routines' time zone: Mixed: Paris, New York" && result.includes("Inbox tidy-up still has New York. The change may still arrive.") && (await focused(p)) === "zone-close:");
  else {
    check("F-196 a failed read leaves the zone line unconfirmed and offers a read-only retry", line === "Routines' time zone: checking needed" && result.includes("Couldn't confirm the time zone of Inbox tidy-up.") && (await focused(p)) === "zone-check:");
    if (await has(p, '[data-r="zone-check"]')) {
      await p.click('[data-r="zone-check"]');
      check("F-196 Check now retries only the read", JSON.stringify(await p.evaluate(() => window.routines.dispatched.map((x) => x.method))) === JSON.stringify(["cron.update", "cron.update", "cron.get", "cron.get"]));
    }
  }
  await p.close();
}
p = await open("view=checkins&bot=otto");
await p.click('[data-r="zone"]');
check("F-196 routines with no zone or a gateway-set schedule are listed as left alone", (await text(p, '[data-testid="zone-change"]')) === "Nightly backup check (now New York)" && (await text(p, '[data-testid="zone-keep"]')) === "Disk space watch (it has no time zone)Certificate renewal (its schedule was set on the gateway)");
await p.selectOption("#z-tz", "Europe/Paris");
await p.click('[data-r="zone-save"]');
await wait(p, 600);
check("F-196 left alone: only the listed routine is written, with its own schedule and the new zone", JSON.stringify(await p.evaluate(() => window.routines.sent)) === JSON.stringify([{ method: "cron.update", params: { id: "backup", patch: { schedule: { kind: "cron", expr: "30 3 * * *", tz: "Europe/Paris" } } } }]) && JSON.stringify(await p.evaluate(() => ["watch", "renewal"].map((id) => window.routines.routine(id).schedule))) === JSON.stringify([{ kind: "every", everyMs: 1800000, anchorMs: 0 }, { kind: "cron", expr: "0 9 1 * *", tz: "Europe/Berlin" }]));
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
check("F-190 a forced run says started by hand", (await text(p, '[data-testid="runs"] li:nth-child(2) .r-run-when')) === "Yesterday 11:40 AM · started by hand");
check("F-355 the footnote: 20 most recent, 7 days, 24 hours", (await text(p, ".r-foot-note")) === "Clawtrate shows the 20 most recent runs. The gateway keeps 7 days of runs, and each run's conversation for 24 hours unless it is set to keep them longer.");
check("page: admin actions Run now, Pause, Edit, More", (await text(p, '[data-r="run-now"]')) === "Run now" && (await text(p, '.r-head [data-r="toggle"]')) === "Pause" && (await text(p, '.r-head [data-r="edit"]')) === "Edit" && (await label(p, '[data-r="more"]')) === "More for Morning digest");

// Run now
await p.click('[data-r="run-now"]');
check("F-351 Run now: Starting…", (await text(p, '[data-r="run-now"]')) === "Starting…");
await wait(p, 650);
check("F-351 then Running… on the page, the rows and the rail (F-024)", (await text(p, '[data-testid="state-line"]')).startsWith("Running since") && (await text(p, '[data-testid="run-row"] .r-run-how')) === "Running…" && (await text(p, '[data-bot-row="marlow"] .bot-preview')) === "Running Morning digest" && (await has(p, '[data-bot-row="marlow"] .glyph[data-state="working"]')));
await p.click('[data-r="run-now"]');
check("F-351 a second Run now while running: It's already running.", (await text(p, ".r-already")) === "It's already running.");
await wait(p, 2000);
check("F-351 finished: the new run on top, started by hand, the rail calm, announced", (await text(p, '[data-testid="run-row"] .r-run-when')) === "Today 10:12 AM · started by hand" && !(await has(p, '[data-bot-row="marlow"] .glyph[data-state="working"]')) && (await live(p)) === "Morning digest finished");
await p.click('[data-r="run-now"]');
await wait(p, 2450);
check("F-351 two completed manual starts keep separate run IDs and history rows", (await count(p, '[data-testid="run-row"]')) === 8 && (await p.evaluate(() => new Set(window.routines.routine("digest").runs.map((r) => r.runId)).size)) === 8);
await p.close();

p = await open("view=routine&routine=cleanup");
check("paused page: state line, Run once now, no next run", (await text(p, '[data-testid="state-line"]')) === "Paused. It won't run until resumed." && (await text(p, '[data-r="run-now"]')) === "Run once now" && (await text(p, '[data-fact="next"] dd')) === "None while paused" && (await text(p, '[data-testid="no-runs"]')) === "No runs yet.");
await p.click('[data-r="run-now"]');
await wait(p, 650);
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
await p.click('[data-testid="runs"] li:first-child [data-testid="run-row"]');
check("F-193 a run opens its conversation: the scheduled message as the gateway recorded it, then the reply", (await text(p, "#view-title")) === "Morning digest" && (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 8:00 AM" && (await text(p, '[data-testid="scheduled-message"] .r-sched-head')) === "Scheduled message, as the gateway recorded it" && (await text(p, '[data-testid="scheduled-message"] p')).startsWith("Summarise the notes I added yesterday, and list anything I need to answer today.\n\nThis is an unattended scheduled run.") && (await has(p, ".r-convo .bubble")));
check("F-190 the run's foot: no reply possible, its usage", (await text(p, '[data-testid="run-foot"]')).startsWith("This run has finished. A run can't be answered; to change what it does, edit the routine.") && (await text(p, ".r-run-facts")) === "scripted/dev-1 · 2.6 s · 120 in, 80 out tokens" && !(await has(p, ".composer-input")));
await p.click('[data-r="back-to-routine"]');
check("Back returns to the routine, focus on the run", (await text(p, "#view-title")) === "Morning digest" && (await p.evaluate(() => document.activeElement === document.querySelector('[data-testid="run-row"]'))));
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
p = await open("view=routine&routine=digest");
for (const sessionTarget of ["session:planning", "current"]) {
  await event(p, { action: "updated", job: { id: "digest", sessionTarget } });
  check(`F-188 a ${sessionTarget} routine names its shared conversation`, (await text(p, '[data-fact="runs-in"] dd')) === "The conversation it was made in");
}
await p.click('[data-testid="run-row"]');
check("F-190 a recorded isolated run still shows its transcript after the routine switches to current", (await text(p, '[data-testid="scheduled-message"] p')).startsWith("Summarise the notes I added yesterday,"));
await p.click('[data-r="back-to-routine"]');
await p.locator('[data-testid="run-row"]').nth(3).click();
check("a shared run with an unknown destination has no conversation link", (await text(p, ".b-note")).startsWith("This run happened in a shared conversation.") && !(await has(p, '.b-note [data-session]')));
await p.click('[data-r="back-to-routine"]');
const sharedKey = "agent:marlow:planning";
await event(p, { action: "finished", job: { id: "digest", sessionTarget: "current", sessionKey: sharedKey }, runId: "shared-run", runAtMs: Date.UTC(2026, 10, 18, 15, 12), sessionKey: "agent:marlow:cron:digest:run:shared-run", status: "ok", summary: "Planning notes." });
await p.click('[data-testid="run-row"]');
check("a shared run names the recorded destination", (await text(p, ".b-note")).includes(sharedKey) && (await text(p, '.b-note [data-session]')) === "Open conversation");
await p.click('.b-note [data-session]');
check("Open conversation goes to the recorded shared destination", (await text(p, "#view-title")) === sharedKey);
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
check("F-193 the rail's run row opens the run; one Back goes to the routine and its runs", (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 8:00 AM" && (await count(p, '.r-head [data-r="back-to-routine"]')) === 1 && (await label(p, '.r-head [data-r="back-to-routine"]')) === "Back to Morning digest, all runs");
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
await p.click("#edit-dialog summary");
if (await has(p, '#e-runs option[value="main"]')) await p.selectOption("#e-runs", "main");
check("F-189 new agent turns only offer an isolated conversation", (await text(p, "#e-runs")) === "A new conversation each time" && !(await has(p, 'select[data-e="runsIn"]')));
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
await wait(p, 700);
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
await wait(p, 500);
check("Check now on an edit: says what the gateway has, as found, and offers Close; Save is not offered", (await text(p, "#edit-dialog .b-note")).startsWith("Morning digest now reads as you typed it. That may be your save, or the same change made elsewhere.") && (await has(p, '#edit-dialog .b-note [data-r="edit-close"]')) && !(await has(p, '.b-foot [data-r="save"]')) && (await p.evaluate(() => document.querySelector("#edit-dialog").open)));
await p.close();
for (const lookup of ["found", "none"]) {
  p = await open(`editstate=noanswer&lookup=${lookup}`);
  await p.click('.r-head [data-r="new"]');
  await p.fill("#e-name", "Evening wrap-up");
  await p.fill("#e-instr", "List what I finished today.");
  await p.click('[data-r="save"]');
  await wait(p, 700);
  check(`no answer on a new routine (${lookup}): the dialog stays, typed input kept, focus on Check now`, (await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await p.inputValue("#e-name")) === "Evening wrap-up" && (await p.evaluate(() => document.activeElement.dataset.r)) === "check-now");
  await p.fill("#e-name", "Evening follow-up");
  await p.selectOption("#e-bot", "otto");
  await p.click('[data-r="check-now"]');
  await wait(p, 500);
  const attempted = () => p.evaluate(() => window.routines.dispatched.map(({ params }) => [params.name, params.agentId]));
  check(`Check now (${lookup}) sends no additional write after the original attempt`, JSON.stringify(await attempted()) === JSON.stringify([["Evening wrap-up", "marlow"]]));
  const words = await text(p, "#edit-dialog .b-note");
  if (lookup === "found")
    check("Check now found a routine with that name: says it may be another client's, offers Open it and a separate Save again", words.startsWith("The gateway has a routine for Marlow named Evening wrap-up, created today 10:12 AM. It may be the one you saved, or one made elsewhere.") && (await has(p, '[data-r="open-found"]')) && (await text(p, '#edit-dialog .b-note [data-r="save"]')) === "Save again" && (await text(p, "#edit-dialog .b-note .r-hint")) === "Saving again makes another routine if that one is yours." && (await p.evaluate(() => window.routines.sent.length)) === 1);
  else check("Check now found nothing: may still arrive; Check again and Save again", words.startsWith("The gateway has no routine for Marlow named Evening wrap-up. The save may still arrive.") && (await has(p, '#edit-dialog .b-note [data-r="check-now"]')) && (await has(p, '#edit-dialog .b-note [data-r="save"]')) && (await p.evaluate(() => window.routines.sent.length)) === 0);
  await p.click('#edit-dialog .b-note [data-r="save"]');
  check(`Save again is its own explicit retry (${lookup})`, (await text(p, '.b-foot [data-r="save"]')) === "Saving…");
  await wait(p, 700);
  const adds = await p.evaluate(() => window.routines.sent.filter((x) => x.method === "cron.add").map((x) => x.params.name));
  check(`Save again (${lookup}): sends one more cron.add, which is answered; the routine's page opens`, JSON.stringify(adds) === JSON.stringify(lookup === "found" ? ["Evening wrap-up", "Evening follow-up"] : ["Evening follow-up"]) && JSON.stringify(await attempted()) === JSON.stringify([["Evening wrap-up", "marlow"], ["Evening follow-up", "otto"]]) && !(await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await text(p, "#view-title")) === "Evening follow-up" && (await live(p)) === "Routine created");
  await p.close();
}
p = await open("edit=open&routine=digest");
await p.fill("#e-name", "Morning notes");
await p.click('[data-r="save"]');
await p.keyboard.press("Escape");
check("Escape while saving: the dialog stays open until the answer", await p.evaluate(() => document.querySelector("#edit-dialog").open));
await wait(p, 700);
check("then the answer closes it, for this draft", !(await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await text(p, "#view-title")) === "Morning notes");
await p.close();
p = await open("edit=open&editstate=locked");
check("a schedule set on the gateway is shown as written and left alone", (await text(p, '[data-testid="locked"]')).includes("0 9 1 * *") && (await text(p, '[data-testid="locked"]')).includes("change its schedule on the gateway.") && !(await has(p, '#e-when')));
await p.close();
const lastSent = (p) => p.evaluate(() => window.routines.sent.at(-1));
const atEq = (a, b) => Date.parse(a) === Date.parse(b);
p = await open();
await event(p, { action: "added", job: { ...EVENING, payload: { kind: "script", script: "echo ready" } } });
await p.click('.r-row-main[data-id="evening"]');
await p.click('.r-head [data-r="edit"]');
check("F-189 a script opens with its script text locked", (await text(p, '[data-testid="payload-locked"]')).startsWith("echo ready"));
await p.fill("#e-name", "Check readiness");
await p.click('[data-r="save"]');
await wait(p, 700);
check("F-189 renaming a script only patches its name", JSON.stringify((await lastSent(p))?.params.patch) === '{"name":"Check readiness"}');
await p.close();
p = await open("edit=open&routine=reminder");
check("a reminder's text is shown, not offered for editing", (await text(p, '[data-testid="payload-locked"]')).startsWith("Reminder: send the newsletter draft to Sam") && !(await has(p, "#e-instr")));
await p.click("#edit-dialog summary");
if (await has(p, '#e-runs option[value="isolated"]')) await p.selectOption("#e-runs", "isolated");
check("F-189 a main-conversation reminder keeps its target", (await text(p, "#e-runs")) === "Marlow's main conversation" && !(await has(p, 'select[data-e="runsIn"]')));
check("Once: the editor opens on the saved instant, in your zone", (await p.inputValue("#e-date")) === "2026-11-20" && (await p.inputValue('[data-e="time"]')) === "09:00" && (await p.inputValue("#e-tz")) === "auto");
await p.fill("#e-name", "Send the draft to Sam today");
await p.click('[data-r="save"]');
await wait(p, 700);
let sent = await lastSent(p);
check("Once: a name-only edit sends the name only, keeps the reminder and leaves the instant", sent.method === "cron.update" && JSON.stringify(sent.params.patch) === '{"name":"Send the draft to Sam today"}' && (await p.evaluate(() => window.routines.routine("reminder").payload.kind)) === "systemEvent" && (await p.evaluate(() => window.routines.routine("reminder").schedule.at)) === "2026-11-20T14:00:00.000Z");
await p.click('.r-head [data-r="edit"]');
await p.fill('[data-e="time"]', "10:00");
await p.selectOption("#e-tz", "Europe/Paris");
await p.click('[data-r="save"]');
await wait(p, 700);
sent = await lastSent(p);
check("Once: a changed time is written as an ISO timestamp with its offset, and no tz", JSON.stringify(sent.params.patch.schedule) === '{"kind":"at","at":"2026-11-20T10:00:00+01:00"}');
check("Once: read back in your zone", (await text(p, '[data-fact="schedule"] dd')) === "Once, Nov 20 at 4:00 AM, New York");
await p.close();
p = await open("edit=new");
await p.fill("#e-name", "Skipped hour");
await p.fill("#e-instr", "Look.");
await p.click('[data-e-kind="once"]');
await p.fill("#e-date", "2027-03-14");
await p.fill('[data-e="time"]', "02:30");
const SKIPPED = "2:30 AM doesn't happen on Mar 14, 2027 in New York: the clocks go forward past it. Pick another time.";
check("Once at a time the clocks skip: the preview says so", (await text(p, '[data-testid="preview"]')) === SKIPPED);
await p.click('[data-r="save"]');
await wait(p, 700);
check("Once at a time the clocks skip: refused under When, nothing sent", (await text(p, "#e-when-error")) === SKIPPED && (await p.evaluate(() => window.routines.dispatched.length)) === 0);
await p.close();
// F-195: the floor is the spacing between consecutive firings, read in croner's grammar,
// the gateway's own (section 9). Each row is what croner 10.0.1 does from the page's clock in
// New York: "ok" with its first firing, "floor" (two firings under 5 minutes apart, across an
// hour or a day included), "error" (the gateway refuses it) or "never".
const CRON_TABLE = [
  ["*/5 * * * *", "ok", "2026-11-18T15:15:00.000Z"], ["0 8 * * 1-5", "ok", "2026-11-19T13:00:00.000Z"], ["0,30 * * * *", "ok", "2026-11-18T15:30:00.000Z"],
  ["0-1/4 * * * *", "ok", "2026-11-18T16:00:00.000Z"], ["0,59 8 * * *", "ok", "2026-11-19T13:00:00.000Z"], ["59 23 * * *", "ok", "2026-11-19T04:59:00.000Z"],
  ["30 */5 * * * *", "ok", "2026-11-18T15:15:30.000Z"], ["0 8 * * 5L", "ok", "2026-11-27T13:00:00.000Z"], ["0 8 15W * *", "ok", "2026-12-15T13:00:00.000Z"],
  ["0 8 * * MON#2,FRI", "ok", "2026-11-20T13:00:00.000Z"], ["@hourly", "ok", "2026-11-18T16:00:00.000Z"], ["0 0 8 * * * 2027", "ok", "2027-01-01T13:00:00.000Z"],
  ["0 9 1 * 1", "ok", "2026-11-23T14:00:00.000Z"], ["0 8 * * +1", "ok", "2026-11-23T13:00:00.000Z"],
  // Passes on the nominal clock (1:59 to 3:00), though the gateway fires it at 06:59Z and 07:00Z on 2027-03-14.
  ["0 0,59 1,3 * * *", "ok", "2026-11-19T06:00:00.000Z"],
  ["*/4 * * * *", "floor"], ["* * * * *", "floor"], ["0,2 * * * *", "floor"], ["*/7 * * * *", "floor"], ["1-59/7 * * * *", "floor"], ["*/5,*/7 * * * *", "floor"],
  ["0,59 23,0 * * *", "floor"], ["0,59 0,23 L,1 * *", "floor"], ["0,59 0,23 1 * ?", "floor"], ["0 */4 * * * *", "floor"], ["*/5 * * * * *", "floor"],
  ["99 * * * *", "error"], ["5/10 * * * *", "error"], ["0 8 * * 5-1", "error"], ["0 24 * * *", "error"], ["0 8 * *", "error"], ["0 0-8-9 * * *", "error"], ["0 8 31 2 *", "never"],
];
// The table itself is checked against croner when the gateway's package is at hand (OPENCLAW_PACKAGE_DIR).
const springExpr = "30 2 14 3 *";
const springRun = "2027-03-14T07:30:00.000Z";
if (process.env.OPENCLAW_PACKAGE_DIR) {
  const gatewayRequire = createRequire(resolve(process.env.OPENCLAW_PACKAGE_DIR, "package.json"));
  const { Cron } = gatewayRequire("croner");
  const from = new Date(Date.UTC(2026, 10, 18, 15, 12));
  const spring = new Cron(springExpr, { timezone: "America/New_York", catch: false });
  check("F-195 pinned Croner shifts 2:30 AM into 3:30 AM", spring.nextRun(from)?.toISOString() === springRun);
  const wrong = CRON_TABLE.filter(([expr, want, next]) => {
    let c;
    try {
      c = new Cron(expr, { timezone: "America/New_York", catch: false });
    } catch {
      return want !== "error";
    }
    // Up to New York's next daylight-saving change, which the floor does not count.
    const runs = c.nextRuns(5000, from).map((d) => d.getTime()).filter((t) => t < Date.UTC(2027, 2, 14));
    if (!runs.length) return want !== "never";
    const gap = Math.min(...runs.slice(1).map((t, i) => t - runs[i]));
    return want !== (gap < 300e3 ? "floor" : "ok") || (next && new Date(runs[0]).toISOString() !== next);
  });
  check("F-195 the cron table is what the gateway's croner does", wrong.length === 0, JSON.stringify(wrong));
}
p = await open();
const spring = await p.evaluate((expr) => window.routines.cron(expr), springExpr);
check("F-195 cron preview uses the shifted instant without shortening nominal spacing", new Date(spring.next[0]).toISOString() === springRun && spring.gap === Infinity);
const overlapping = await p.evaluate(() => window.routines.cron("0 0,30 2,3 14 3 *").next);
check("F-195 cron preview lists distinct instants in order across the spring gap", JSON.stringify(overlapping.map((t) => new Date(t).toISOString())) === JSON.stringify(["2027-03-14T07:00:00.000Z", "2027-03-14T07:30:00.000Z", "2028-03-14T06:00:00.000Z"]));
const read = await p.evaluate((rows) => rows.map(([expr]) => window.routines.cron(expr)), CRON_TABLE);
const misread = CRON_TABLE.filter(([, want, next], i) => {
  const g = read[i];
  const v = g.error ? "error" : !g.fires ? "never" : g.gap < 300 ? "floor" : "ok";
  return v !== want || (next && new Date(g.next[0]).toISOString() !== next);
});
check(`F-195 the page reads all ${CRON_TABLE.length} expressions as croner does: refusal, floor and first firing`, misread.length === 0, JSON.stringify(misread));
await p.close();
p = await open("view=week");
await event(p, { action: "updated", job: { id: "backup", schedule: { kind: "cron", expr: "30 2 * * *", tz: "America/New_York" } } });
await p.evaluate(() => {
  for (let i = 0; i < 16; i++) document.querySelector('[data-r="cal-move"][data-v="1"]').click();
});
check("F-197 calendar draws the shifted spring occurrence at 3:30 AM", (await label(p, '[data-testid="cal-day"][aria-label="Sun Mar 14"] [data-id="backup"]')).includes("Sun 3:30 AM"));
await p.close();
p = await open("view=week");
await event(p, { action: "updated", job: { id: "backup", schedule: { kind: "cron", expr: "30 3 * * *" }, state: { nextRunAtMs: Date.UTC(2026, 10, 19, 12) } } });
const unknownZone = '[data-testid="occurrence"][data-id="backup"][data-past="false"]';
check("F-197 unknown gateway zone draws only the gateway's next run", (await count(p, unknownZone)) === 1 && (await label(p, unknownZone)).includes("Thu 7:00 AM"));
await event(p, { action: "updated", job: { id: "backup", state: {} } });
check("F-197 unknown gateway zone with no reported next run draws no future chips", (await count(p, unknownZone)) === 0);
await p.click('[data-testid="occurrence"][data-id="backup"][data-past="true"]');
check("F-188 unknown gateway zone with no reported next run states that on the routine page", (await text(p, '[data-fact="next"] dd')) === "The gateway hasn't reported a next run.");
await p.close();

for (const [expr, want] of CRON_TABLE) {
  p = await open("edit=new");
  await p.fill("#e-name", "Often");
  await p.fill("#e-instr", "Look.");
  await p.click("#edit-dialog summary");
  await p.fill("#e-cron", expr);
  await p.click('[data-r="save"]');
  await wait(p, 700);
  const err = await text(p, "#e-cron-error");
  const got = await p.evaluate(() => window.routines.sent);
  if (want === "ok")
    check(`F-195 cron ${expr}: saved as written, and the new routine's page opens`, !err && got.length === 1 && got[0].method === "cron.add" && JSON.stringify(got[0].params.schedule) === JSON.stringify({ kind: "cron", expr, tz: "America/New_York" }) && (await text(p, "#view-title")) === "Often");
  else
    check(`F-195 cron ${expr}: refused before any request (${want})`, (await p.evaluate(() => window.routines.dispatched.length === 0 && document.querySelector("#edit-dialog").open)) && (want === "floor" ? err === "Routines run at least 5 minutes apart." : want === "never" ? err === "This never runs in the next eight years." : err.startsWith("The gateway can't read this: ")), err);
  await p.close();
}
p = await open();
const createdIds = [];
for (const name of ["First new routine", "Second new routine", "Third new routine"]) {
  await p.click('.r-head [data-r="new"]');
  await p.fill("#e-name", name);
  await p.fill("#e-instr", "Look.");
  await p.click('[data-r="save"]');
  await wait(p, 700);
  createdIds.push(await p.locator('[data-r="more"]').getAttribute("data-id"));
  if (name === "Third new routine") break;
  await p.click('.r-head [data-r="back"]');
  if (name === "Second new routine") {
    await p.getByRole("button", { name: /^First new routine/ }).click();
    await p.click('[data-r="more"]');
    await p.click('#r-menu [data-r="delete"]');
    await p.click('[data-r="confirm-delete"]');
  }
}
check("F-189 each create gets a fresh id and opens its own page after a deletion", (await text(p, "#view-title")) === "Third new routine" && new Set(createdIds).size === 3);
await p.close();
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
check("a custom prompt: the note says what the gateway's own prompt asks, and claims nothing about this one", (await text(p, '[data-testid="prompt-note"]')) === "This prompt replaces the gateway's own, which asks Marlow to reply NO_REPLY when nothing needs attention. Whether Marlow stays quiet depends on what this prompt asks.");
await p.click('[data-r="ci-save"]');
await p.keyboard.press("Escape");
check("check-ins: Escape while saving keeps the dialog until the answer", await p.evaluate(() => document.querySelector("#checkins-dialog").open));
await wait(p, 700);
check("F-201 saved: Marlow daily, said from its own prompt, announced", (await text(p, '[data-testid="checkins-text"]')) === "Once a day, Marlow checks in with a prompt of its own." && (await live(p)) === "Check-ins saved");
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
await p.click('[data-testid="created-card"] .r-link');
check("F-108 opened", (await text(p, "#view-title")) === "Morning digest");
await p.close();
p = await open("transcript=checkin");
await p.focus('[data-testid="created-card"] .r-link');
await p.keyboard.press("Enter");
check("F-108 the card's name opens the routine with Enter", (await text(p, "#view-title")) === "Morning digest");
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

// What Save sends: the delivery object the pinned schema requires -------------------------------
p = await open("edit=new");
await p.fill("#e-name", "Evening wrap-up");
await p.fill("#e-instr", "List what I finished today.");
await p.click('[data-r="save"]');
await wait(p, 700);
let req = (await p.evaluate(() => window.routines.sent))[0];
check("create with the default Results: delivery is {mode: none}, and the request passes the pinned schema", JSON.stringify(req.params.delivery) === '{"mode":"none"}' && validateCronAddParams(req.params));
await p.close();
p = await open("edit=new");
await p.fill("#e-name", "Evening wrap-up");
await p.fill("#e-instr", "List what I finished today.");
await p.click("#edit-dialog summary");
await p.selectOption("#e-results", "announce");
await p.click('[data-r="save"]');
await wait(p, 700);
req = (await p.evaluate(() => window.routines.sent))[0];
check("create with Also announce: delivery is {mode: announce}", JSON.stringify(req.params.delivery) === '{"mode":"announce"}' && validateCronAddParams(req.params));
await p.close();
p = await open("edit=open&routine=backup");
await p.click("#edit-dialog summary");
await p.selectOption("#e-results", "announce");
await p.click('[data-r="save"]');
await wait(p, 700);
req = (await p.evaluate(() => window.routines.sent))[0];
check("edit Results: the patch carries only the mode, and the routine keeps its other delivery fields", JSON.stringify(req.params) === JSON.stringify({ id: "backup", patch: { delivery: { mode: "announce" } } }) && validateCronUpdateParams(req.params) && JSON.stringify(await p.evaluate(() => window.routines.routine("backup").delivery)) === JSON.stringify({ mode: "announce", failureDestination: { mode: "announce", channel: "last" } }) && (await text(p, '[data-fact="results"] dd')) === "Announced to the gateway's channels");
await p.close();

p = await open("edit=new");
await p.fill("#e-name", "Distant reminder");
await p.fill("#e-instr", "Check the date.");
await p.click('[data-e-kind="once"]');
await p.fill("#e-date", "2029-01-01");
await p.click('[data-r="save"]');
await wait(p, 700);
check("F-188 a distant Once shows its stored future instant", (await text(p, '[data-fact="next"] dd')).includes("Jan 1"));
await p.close();
p = await open("view=routine&routine=backup");
await event(p, { action: "updated", job: { id: "backup", schedule: { kind: "cron", expr: "0 0 9 1 1 * 2029", tz: "America/New_York" } } });
check("F-188 a distant cron uses the eight-year horizon", (await text(p, '[data-fact="next"] dd')).includes("Jan 1"));
await event(p, { action: "updated", job: { id: "backup", state: { nextRunAtMs: Date.UTC(2026, 10, 19, 12) } } });
check("F-188 gateway next run takes precedence over a computed fallback", (await text(p, '[data-fact="next"] dd')).endsWith("Nov 19, 7:00 AM"));
await p.close();

// Once with its date or time cleared: said, never thrown ---------------------------------------------
p = await open("edit=new");
await p.fill("#e-name", "Call the venue");
await p.fill("#e-instr", "Remind me to call the venue.");
await p.click('[data-e-kind="once"]');
await p.fill("#e-date", "");
check("Once with no date: the preview asks for one", (await text(p, '[data-testid="preview"]')) === "Choose a date and a time to see when it runs.");
await p.click('[data-r="save"]');
await wait(p, 700);
check("Once with no date: Save says what is missing and sends nothing", (await text(p, "#e-when-error")) === "Choose a date and a time." && (await p.evaluate(() => window.routines.dispatched.length)) === 0);
await p.fill("#e-date", "2026-11-21");
await p.fill('[data-e="time"]', "");
check("Once with no time: the preview asks for it", (await text(p, '[data-testid="preview"]')) === "Choose a date and a time to see when it runs.");
await p.close();
p = await open("edit=new");
await p.fill("#e-time", "");
check("Every day with no time: the preview asks for one", (await text(p, '[data-testid="preview"]')) === "Choose a time to see when it runs.");
await p.close();

// Run identity: the open run is the one chosen, by its gateway id ----------------------------------
// A \`finished\` event as the gateway sends it: its fields at the top level, \`runId\` optional.
const FIN = (jobId, runId, h, min, extra = {}) => ({ action: "finished", jobId, ...(runId ? { runId } : {}), runAtMs: Date.UTC(2026, 10, 18, h + 5, min), status: "ok", completionStatus: "succeeded", durationMs: 2000, usage: { input_tokens: 60, output_tokens: 40, total_tokens: 100 }, ...extra });
p = await open("view=run&routine=digest&run=0");
await event(p, FIN("digest", "other-1", 10, 0));
check("a finished run elsewhere doesn't replace the run being read", (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 8:00 AM" && (await text(p, '[data-testid="scheduled-message"] p')).startsWith("Summarise the notes I added yesterday, and list"));
await p.click('[data-r="back-to-routine"]');
check("the other run joins the list in time order, and focus returns to the run that was open", (await count(p, '[data-testid="run-row"]')) === 7 && (await text(p, '[data-testid="run-row"] .r-run-when')) === "Today 10:00 AM" && (await p.evaluate(() => document.activeElement.querySelector(".r-run-when")?.textContent)) === "Today 8:00 AM");
await p.close();
p = await open("view=run&routine=digest&run=-1&state=running");
check("the running run's view", (await text(p, '[data-testid="run-foot"]')).trim() === "Running…" && (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 10:11 AM");
await event(p, FIN("digest", "other-2", 9, 0));
check("another run's finish leaves the running run open and running, and the rail's working mark", (await text(p, '[data-testid="run-foot"]')).trim() === "Running…" && (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 10:11 AM" && (await has(p, '[data-bot-row="marlow"] .glyph[data-state="working"]')) && (await text(p, '[data-bot-row="marlow"] .bot-preview')) === "Running Morning digest");
await event(p, FIN("digest", "own-1", 10, 11, { history: { message: "Summarise.", reply: "Done." } }));
check("its own finish (same runAtMs) becomes the open run, with its time kept", (await text(p, '[data-testid="run-foot"]')).startsWith("This run has finished.") && (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 10:11 AM" && (await text(p, ".r-convo .bubble")) === "Done.");
await p.click('[data-r="back-to-routine"]');
check("back on the page the finished run is one row, not a running row and a finished one", (await count(p, '[data-testid="run-row"]')) === 8 && !(await p.evaluate(() => /Running…/.test(document.querySelector('[data-testid="runs"]').textContent))) && (await p.evaluate(() => document.activeElement.dataset.run)) === "own-1");
await p.close();
p = await open("view=run&routine=digest&run=-1&state=running");
const threw = await p.evaluate(() => { try { window.routines.event({ action: "finished", jobId: "digest", runId: "r", runAtMs: 1795014660000, status: "ok" }); return ""; } catch (e) { return String(e); } });
check("a finished event with only the gateway's top-level fields is applied", threw === "", threw);
await p.close();
p = await open("view=run&routine=digest&run=-1&state=running");
await event(p, FIN("digest", null, 10, 11));
check("a finish with no runId is known by its runAtMs: the open running run becomes it", (await text(p, '[data-testid="run-foot"]')).startsWith("This run has finished.") && (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 10:11 AM" && !(await has(p, '[data-bot-row="marlow"] .glyph[data-state="working"]')));
await p.click('[data-r="back-to-routine"]');
check("and back on the page it is one row, focused by that identity", (await count(p, '[data-testid="run-row"]')) === 7 && (await p.evaluate(() => document.activeElement.dataset.run)) === `at:${Date.UTC(2026, 10, 18, 15, 11)}`);
await p.close();
p = await open("view=run&routine=digest&run=-1");
check("run=-1 with nothing running: the run isn't available, no 1969 date", (await text(p, '[data-testid="run-missing"] h4')) === "This run isn't available." && !(await p.evaluate(() => /1969|Dec 31/.test(document.body.textContent))));
await p.close();
for (const q of ["view=run&state=noruns", "view=run&run=99"]) {
  p = await open(q);
  check(`${q}: the run isn't available, with the way back`, (await text(p, '[data-testid="run-missing"] h4')) === "This run isn't available." && (await count(p, '[data-r="back-to-routine"]')) === 2);
  await p.close();
}
p = await open("view=run&routine=digest&run=0");
await event(p, { action: "removed", jobId: "digest" });
check("the routine removed while its run is open: the run stays, Edit routine goes, announced", !(await has(p, '[data-r="edit"]')) && (await text(p, '[data-testid="run-when"]')) === "Marlow · Today 8:00 AM" && (await live(p)) === "Morning digest was deleted elsewhere");
await p.click('[data-r="back-to-routine"]');
check("and its page then says it was deleted", (await text(p, ".b-note")).startsWith("This routine was deleted. It won't run again.") && !(await has(p, '[data-r="run-now"]')));
await p.close();
p = await open("view=routine&routine=reminder");
await event(p, FIN("reminder", "once-1", 10, 12, { summary: "Posted the reminder.", manual: false, nextRunAtMs: null }));
await event(p, { action: "removed", jobId: "reminder" });
check("a one-shot's finished then removed: it ran once and the gateway removed it, with its run", (await text(p, ".b-note")).startsWith("This routine ran once, and the gateway removed it. Its run succeeded today 10:12 AM.") && (await count(p, '[data-testid="run-row"]')) === 1);
await p.close();
p = await open("view=routine&routine=reminder");
await event(p, FIN("reminder", "once-2", 10, 12, { status: "error", completionStatus: "failed", error: "The model didn't answer." }));
await event(p, { action: "removed", jobId: "reminder" });
check("a one-shot removed after a failed run reads as deleted, not as ran once", (await text(p, ".b-note")).startsWith("This routine was deleted."));
await p.close();

// An unanswered save: no Save until the gateway has been checked ----------------------------------
const footSave = (p) => p.evaluate(() => !!document.querySelector('#edit-dialog .b-foot [data-r="save"]'));
p = await open("edit=open&routine=digest&editstate=noanswer");
check("no answer: the foot offers no Save", !(await footSave(p)) && (await has(p, '#edit-dialog .b-foot [data-r="edit-close"]')));
await p.close();
p = await open("view=routine&routine=digest&editstate=noanswer&lookup=found");
await p.click('.r-head [data-r="edit"]');
await p.fill("#e-time", "09:00");
await p.click('[data-r="save"]');
await event(p, { action: "updated", job: { id: "digest", schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "America/New_York" } } });
await wait(p, 700);
check("a schedule edit unanswered: no Save in the foot while the outcome is unknown", !(await footSave(p)) && (await has(p, '[data-r="check-now"]')));
await p.click('[data-r="check-now"]');
check("checking: still no Save", !(await footSave(p)));
await wait(p, 500);
check("it landed: Check now compares what was sent with the job and says it reads as typed", (await text(p, "#edit-dialog .b-note")).startsWith("Morning digest now reads as you typed it.") && !(await footSave(p)));
await p.close();
p = await open("view=routine&routine=digest&editstate=noanswer&lookup=found");
await p.click('.r-head [data-r="edit"]');
await p.fill("#e-name", "My digest");
await p.click('[data-r="save"]');
await wait(p, 700);
await event(p, { action: "updated", job: { id: "digest", name: "Theirs", updatedAtMs: Date.UTC(2026, 10, 18, 15, 12) } });
check("changed elsewhere while a save is unanswered: Check now stays, and no write is offered", (await has(p, '[data-r="check-now"]')) && !(await has(p, '[data-r="conflict-save"]')) && !(await footSave(p)));
await p.click('[data-r="check-now"]');
await wait(p, 500);
check("once checked, the change elsewhere is shown; one write was sent", (await has(p, '[data-r="conflict-show"]')) && (await p.evaluate(() => window.routines.dispatched.length)) === 1);
await p.close();
p = await open("view=routine&routine=digest&editstate=noanswer");
await p.click('.r-head [data-r="edit"]');
await p.fill("#e-time", "09:00");
await p.click('[data-r="save"]');
await wait(p, 700);
await p.click('[data-r="check-now"]');
await wait(p, 500);
check("it didn't land: says the gateway differs, with what it has, and offers Save again in the note", (await text(p, "#edit-dialog .b-note")).startsWith("Morning digest doesn't read as you typed it. The gateway has: Morning digest, Weekdays at 8:00 AM, New York.") && (await has(p, '#edit-dialog .b-note [data-r="save"]')) && !(await footSave(p)));
check("the unanswered attempt is a dispatched request, not a landed write", (await p.evaluate(() => `${window.routines.dispatched.length},${window.routines.sent.length}`)) === "1,0");
await p.close();
for (const q of ["edit=new&editstate=saving", "edit=open&routine=digest&editstate=saving"]) {
  p = await open(q);
  check(`${q}: Saving…, focus on the dialog's heading, and Escape waits`, (await text(p, '[data-r="save"]')) === "Saving…" && (await p.evaluate(() => document.activeElement.id)) === "edit-title" && (await p.keyboard.press("Escape").then(() => p.evaluate(() => document.querySelector("#edit-dialog").open))));
  await wait(p, 4200);
  check(`${q}: when the wait ends, focus moves to Check now`, (await p.evaluate(() => document.activeElement.dataset.r)) === "check-now");
  check(`${q}: the wait ends as no answer, with Check now, and Escape closes again`, (await text(p, "#edit-dialog .b-note")).startsWith("The gateway didn't answer.") && !(await footSave(p)) && (await p.keyboard.press("Escape").then(() => p.evaluate(() => !document.querySelector("#edit-dialog").open))));
  await p.close();
}

p = await open("edit=open&routine=digest");
await p.fill("#e-name", "Keep this draft");
await p.click('[data-r="save"]');
await event(p, { action: "removed", jobId: "digest" });
await wait(p, 700);
check("a removal during Save keeps the unanswered draft without applying the edit", (await has(p, '[data-r="check-now"]')) && (await p.inputValue("#e-name")) === "Keep this draft" && (await p.evaluate(() => window.routines.sent.length)) === 0);
await p.click('[data-r="check-now"]');
await wait(p, 500);
await p.click('[data-r="save-as-new"]');
await wait(p, 700);
check("the removed routine's draft can still be saved as new", (await lastSent(p))?.method === "cron.add" && (await text(p, "#view-title")) === "Keep this draft");
await p.close();

// Changed or deleted elsewhere: the draft is kept, and every retry is the validated save ------------
p = await open("edit=open&routine=digest");
await p.fill("#e-name", "My digest");
await event(p, { action: "updated", job: { id: "digest", updatedAtMs: Date.UTC(2026, 10, 18, 15, 12) } });
await p.click('[data-r="save"]');
check("the pre-save read catches a newer revision before writing", (await has(p, '[data-r="conflict-save"]')) && (await p.evaluate(() => window.routines.dispatched.length)) === 0);
await p.click('[data-r="conflict-save"]');
await wait(p, 700);
check("the explicit override accepts that revision and applies only the draft's change", JSON.stringify((await lastSent(p))?.params.patch) === '{"name":"My digest"}');
await p.close();
p = await open("edit=open&routine=digest");
await p.fill("#e-name", "Mine");
await p.fill("#e-instr", "My instruction.");
await event(p, { action: "updated", job: { id: "digest", name: "Theirs", updatedAtMs: Date.UTC(2026, 10, 18, 15, 12) } });
check("changed elsewhere: the foot offers no Save, only the note's choices", !(await footSave(p)) && (await has(p, '[data-r="conflict-show"]')) && (await has(p, '[data-r="conflict-save"]')));
await p.click('[data-r="conflict-show"]');
check("Show the new version: the fields read theirs, and Your version keeps what was typed", (await p.inputValue("#e-name")) === "Theirs" && (await text(p, '[data-testid="your-version"] summary')) === "Your version" && (await text(p, '[data-testid="your-version"] dl')) === "NameMineInstructionMy instruction.WhenWeekdays at 8:00 AM, New York");
await p.close();
p = await open("edit=open&routine=digest");
await p.fill("#e-name", "");
await event(p, { action: "updated", job: { id: "digest", name: "Theirs" } });
await p.click('[data-r="conflict-save"]');
await wait(p, 700);
check("Save mine anyway is validated: an empty name is refused and nothing is sent", (await text(p, "#e-name-error")) === "Give it a name." && (await p.evaluate(() => window.routines.dispatched.length)) === 0);
await p.fill("#e-name", "Mine");
await p.click('[data-r="save"]');
await wait(p, 700);
check("then saved: only what was typed is sent, and the dialog closes", JSON.stringify(await p.evaluate(() => window.routines.sent)) === JSON.stringify([{ method: "cron.update", params: { id: "digest", patch: { name: "Mine" } } }]) && (await text(p, "#view-title")) === "Mine");
await p.close();
p = await open("edit=open&routine=digest&editstate=conflict");
await p.click('[data-r="conflict-save"]');
check("Save mine anyway shows Saving…", (await text(p, '[data-r="save"]')) === "Saving…");
await wait(p, 700);
check("and the address's conflict was the first attempt's only: it saves", !(await p.evaluate(() => document.querySelector("#edit-dialog").open)) && (await live(p)) === "Saved");
await p.close();
p = await open("edit=open&routine=reminder");
await p.fill("#e-name", "");
await event(p, { action: "removed", jobId: "reminder" });
await p.click('[data-r="save-as-new"]');
await wait(p, 700);
check("Save as a new routine is validated: an empty name is refused and nothing is sent", (await text(p, "#e-name-error")) === "Give it a name." && (await p.evaluate(() => window.routines.dispatched.length)) === 0);
await p.fill("#e-name", "Send the draft to Sam");
await p.click('[data-r="save"]');
await wait(p, 700);
req = (await p.evaluate(() => window.routines.sent))[0];
check("then created as new, with the reminder, its instant and its delivery", req.method === "cron.add" && req.params.payload.kind === "systemEvent" && req.params.schedule.kind === "at" && atEq(req.params.schedule.at, "2026-11-20T14:00:00.000Z") && JSON.stringify(req.params.delivery) === '{"mode":"announce"}' && validateCronAddParams(req.params) && (await live(p)) === "Routine created");
await p.close();

// Calendar: runs at the same time don't cover each other ------------------------------------------
const overlapFree = (p) => p.evaluate(() => {
  const chips = [...document.querySelectorAll('[data-testid="occurrence"]')];
  const hits = chips.map((c) => { c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".r-occ") === c; });
  const rects = chips.map((c) => c.getBoundingClientRect());
  const cross = rects.some((a, i) => rects.some((b, j) => i < j && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom));
  return { n: chips.length, reach: hits.every(Boolean), cross };
});
for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  p = await open(`view=day${vp.width === 390 ? "&width=phone" : ""}`, vp);
  await event(p, FIN("digest", "same-time", 3, 30));
  const r = await overlapFree(p);
  check(`${vp.width} day: two runs at 3:30 AM are side by side, each reached by the pointer at its centre`, r.n === 4 && r.reach && !r.cross, JSON.stringify(r));
  await p.close();
}
p = await open("view=week");
const NEXT = Date.UTC(2026, 10, 19, 14, 0);
await event(p, { action: "added", job: { id: "paced", bot: "pip", name: "Watch the inbox", enabled: true, schedule: { kind: "cron", expr: "0 9 * * *", tz: "America/New_York" }, pacing: { min: "10m", max: "2h" }, state: { nextRunAtMs: NEXT }, payload: { kind: "agentTurn", message: "Watch." }, sessionTarget: "isolated", delivery: { mode: "none" } } });
check("a schedule Clawtrate can't expand is drawn once, at the gateway's next run", (await count(p, '[data-testid="occurrence"][data-id="paced"]')) === 1 && (await label(p, '[data-testid="occurrence"][data-id="paced"]')) === "Watch the inbox, Pip, Thu 9:00 AM, and later, as the gateway decides. May start up to 5 minutes later.");
await p.close();
p = await open("edit=new");
await p.fill("#e-name", "Often");
await p.fill("#e-instr", "Look.");
await p.click("#edit-dialog summary");
await p.fill("#e-cron", "*/5 * * * *");
await p.click('[data-r="save"]');
await wait(p, 700);
check("an accepted */5 routine has its next run on its page", (await text(p, '[data-fact="next"] dd')) === "Today, Wed Nov 18, 10:15 AM");
await p.click('.r-head [data-r="back"]');
await p.click('[data-r="seg"][data-v="week"]');
check("and the calendar draws it, as a band since it runs more than four times a day", (await p.evaluate(() => [...document.querySelectorAll(".r-cal-band")].map((x) => x.textContent))).includes("Often · */5 * * * *"));
await p.close();

// Check-ins: "asks it to stay quiet" only for the built-in prompt; any other is the cadence alone ----------
p = await open("view=checkins&bot=marlow");
await p.click('[data-r="checkins"]');
await p.click('[data-ci="asneeded"]');
await p.click("#checkins-dialog summary");
await p.fill("[data-ci-prompt]", "Never reply NO_REPLY. Report on every check.");
check("As needed with a custom prompt that mentions NO_REPLY: no claim about quiet", (await p.evaluate(() => document.querySelector('[data-ci="asneeded"] .b-choice-sub').textContent)) === "Every 30 minutes, Marlow checks in with a prompt of its own.");
await p.click('[data-r="ci-save"]');
await wait(p, 700);
check("saved with that prompt: the block says the cadence only", (await text(p, '[data-testid="checkins-text"]')) === "Every 30 minutes, Marlow checks in with a prompt of its own.");
await p.close();
p = await open("view=checkins&bot=juniper&defaultprompt=custom");
check("an empty prompt under a custom gateway default: the cadence only", (await text(p, '[data-testid="checkins-text"]')) === "Every 30 minutes, Juniper checks in with the prompt the gateway sets for every bot.");
await p.close();
for (const q of ["view=checkins&bot=juniper&defaultprompt=unreadable", "view=checkins&bot=juniper&access=read"]) {
  p = await open(q);
  check(`${q}: a prompt Clawtrate can't read: the cadence only`, (await text(p, '[data-testid="checkins-text"]')) === "Every 30 minutes, Juniper checks in. Clawtrate can't read its prompt.");
  await p.close();
}

for (const defaultPrompt of ["custom", "unreadable"]) {
  p = await open(`view=checkins&bot=juniper&defaultprompt=${defaultPrompt}`);
  await p.click('[data-r="checkins"]');
  await p.click("#checkins-dialog summary");
  await p.fill("[data-ci-prompt]", "Tell me about my day.");
  check(`check-in prompt replacement (${defaultPrompt}) makes no claim about the default asking for silence`, (await text(p, '[data-testid="prompt-note"]')) === "This prompt replaces the gateway's default for this bot. Whether Juniper stays quiet depends on what this prompt asks.");
  await p.close();
}
p = await open("view=checkins&bot=otto");
await p.click('[data-r="zone"]');
await p.click('[data-r="zone-save"]');
await event(p, { action: "added", job: { id: "another-backup", bot: "otto", name: "Another backup", schedule: { kind: "cron", expr: "30 4 * * *", tz: "Europe/Paris" }, payload: { kind: "agentTurn", message: "Check the backup." } } });
await wait(p, 600);
check("F-196 newly eligible routines require a new confirmation before any writes", (await text(p, '[data-testid="zone-change"]')).includes("Another backup") && (await has(p, '[data-r="zone-save"]')) && (await p.evaluate(() => window.routines.dispatched.length)) === 0);
await p.click('[data-r="zone-save"]');
await wait(p, 600);
check("F-196 reconfirming writes the two newly disclosed targets", JSON.stringify(await p.evaluate(() => window.routines.sent.map((r) => r.params.id))) === '["backup","another-backup"]');
await p.close();

// Try again reads again ------------------------------------------------------------------------------
p = await open("view=routine&routine=digest&state=runs-error");
await p.click('[data-r="runs-retry"]');
check("runs couldn't load, Try again: loading, announced", (await has(p, '[data-testid="runs-loading"][aria-busy="true"]')) && !(await has(p, '[data-testid="runs-error"]')) && (await live(p)) === "Loading runs");
await wait(p, 500);
check("then the runs", (await count(p, '[data-testid="run-row"]')) === 6 && (await p.evaluate(() => document.activeElement.id)) === "runs-head");
await p.close();
p = await open("view=run&routine=digest&run=0&runstate=error");
await p.click('[data-r="run-retry"]');
check("a run couldn't load, Try again: loading", (await has(p, '.r-convo[aria-busy="true"]')) && !(await has(p, '[data-testid="run-error"]')));
await wait(p, 500);
check("then the run", (await text(p, '[data-testid="scheduled-message"] .r-sched-head')) === "Scheduled message, as the gateway recorded it" && (await has(p, ".r-convo .bubble")));
await p.close();

// The gallery: every routines state it links to opens without an error, and the specimens ---------
p = await b.newPage();
const galleryErrors = [];
p.on("pageerror", (e) => galleryErrors.push(String(e)));
await p.goto(pageUrl("gallery.html") + "?chrome=0&theme=light&section=proactive");
const links = await p.evaluate(() => [...document.querySelectorAll('a[href^="routines.html"]')].map((a) => a.getAttribute("href")));
// Every address-only state section 18 names, by its address.
const REQUIRED = [
  "state=loading", "state=error", "state=empty", "state=scheduler-off", "pausefail=1", "away=1", "away=1&prefs=none",
  "access=read", "access=write", "access=read&req=requested", "access=read&req=denied", "access=read&req=expired", "access=read&req=failed",
  "view=routine&routine=digest&state=running", "view=routine&routine=digest&state=paused", "view=routine&routine=digest&state=noruns", "view=routine&routine=digest&state=failed", "view=routine&routine=digest&state=deleted", "view=routine&routine=reminder&state=ran-once", "view=routine&routine=digest&state=runs-error", "view=routine&routine=digest&runs=25", "view=routine&routine=digest&hooks=on", "view=routine&routine=digest&runfail=1", "view=routine&routine=backup&deletefail=1&confirm=delete",
  "view=run&routine=digest&run=0", "view=run&routine=digest&run=3", "view=run&routine=reminder&run=0&state=ran-once", "view=run&routine=digest&run=0&runstate=running", "view=run&routine=digest&run=0&runstate=loading", "view=run&routine=digest&run=0&runstate=error", "view=run&routine=digest&run=99",
  "edit=new", "edit=open&routine=digest", "edit=new&editstate=invalid", "edit=new&editstate=saving", "edit=open&routine=digest&editstate=refused", "edit=open&routine=digest&editstate=noanswer", "edit=open&routine=digest&editstate=conflict", "edit=open&routine=digest&editstate=deleted", "editstate=locked", "edit=open&routine=digest&editstate=adminlost",
  "view=checkins&bot=juniper", "view=checkins&bot=marlow&dialog=open&catch=1", "view=checkins&bot=juniper&checkins=off", "transcript=checkin", "transcript=checkin&live=0", "checkin=running", "view=checkins&bot=juniper&defaultprompt=custom", "view=checkins&bot=juniper&defaultprompt=unreadable", "view=checkins&bot=pip&tzfail=cleanup",
  "view=day", "view=3day", "view=week",
].map((q) => `routines.html?${q}`);
const missingLinks = REQUIRED.filter((q) => !links.includes(q));
check("gallery: links to every address-only routines state by name", missingLinks.length === 0, JSON.stringify(missingLinks));
check("gallery F-200: an offer is a reply, with no offer card or Accept button", (await text(p, "#proactive .spec:nth-of-type(1) .bubble")).startsWith("The venue's quote expires on Friday") && !(await p.evaluate(() => [...document.querySelector("#proactive .spec-box").querySelectorAll("button, .card")].length)));
const connector = p.locator("#proactive .spec-box").nth(1);
const connectorAction = connector.locator(".action");
await connectorAction.locator("summary").first().click();
check("gallery F-364: the action card shows the tool's error and the reply offers to reconnect", (await connectorAction.innerText()).includes("401 Unauthorized") && (await connector.innerText()).includes("Gmail signed me out") && (await connector.getByRole("button", { name: "Reconnect" }).count()) === 0);
await connectorAction.getByText("Raw", { exact: true }).click();
check("gallery F-364: Raw shows the recorded connector call", (await connectorAction.innerText()).includes("gmail__search_messages"));
await p.close();
for (const href of links) {
  const pg = await b.newPage({ viewport: { width: 1100, height: 760 } });
  const errs = [];
  pg.on("pageerror", (e) => errs.push(String(e)));
  // The optional local fonts file is absent from a fresh copy by design (README.md).
  pg.on("console", (m) => m.type() === "error" && !m.location().url?.endsWith("/fonts.local.css") && errs.push(m.text()));
  await pg.goto(pageUrl(href) + (href.includes("?") ? "&" : "?") + "chrome=0");
  await pg.waitForTimeout(120);
  if (errs.length) check(`gallery link ${href}: no errors`, false, JSON.stringify(errs));
  galleryErrors.push(...errs);
  await pg.close();
}
check(`gallery: every linked routines state opens without a page or console error`, galleryErrors.length === 0, JSON.stringify(galleryErrors.slice(0, 3)));

// Widths, themes, motion ------------------------------------------------------------------------
// Clipped inside a container: anything in the app, rail and open dialogs included, that hides
// overflow and has more than it shows, except a shortened line whose full words are in a
// tooltip or its control's accessible name, and the calendar where it scrolls by design.
const clipped = (pg, scrollOk) => pg.evaluate((scrollOk) => [...document.querySelectorAll("#root *")].filter((e) => {
  const cs = getComputedStyle(e);
  if (!["hidden", "auto", "scroll", "clip"].includes(cs.overflowX) || e.scrollWidth <= e.clientWidth + 1 || !e.getClientRects().length) return false;
  if (cs.textOverflow === "ellipsis" && (e.closest("[title]") || e.closest("[aria-label]")?.getAttribute("aria-label").includes(e.textContent))) return false;
  return !(scrollOk && e.matches(".r-cal-scroll"));
}).map((e) => e.className || e.tagName), scrollOk);
// A 44 px hit area, and the pointer reaches it: whole-pixel points from the centre pixel, 22 px
// up and left and 21 px down and right, with the diagonals of a 44 px circle, all land on the
// control, so a target under 44 px, or a neighbour lying over part of it, fails. A circle,
// because a round button is hit only inside its circle. With a dialog or the menu open only
// its controls count.
const smallTargets = (pg) => pg.evaluate(() => {
  const scope = document.querySelector("dialog[open]") || document.querySelector("#r-menu:not([hidden])") || document.querySelector("#root");
  const pts = [[0, 0], [0, -22], [0, 21], [-22, 0], [21, 0], [-15, -15], [15, -15], [-15, 15], [15, 15], [0, -11], [0, 11], [-11, 0], [11, 0]];
  return [...scope.querySelectorAll('button, [role="switch"], select, input, textarea, summary')].filter((e) => e.checkVisibility({ visibilityProperty: true }) && !e.disabled).filter((e) => {
    e.scrollIntoView({ block: "center", inline: "center" });
    const r = e.getBoundingClientRect();
    const x = Math.floor(r.left + r.width / 2);
    const y = Math.floor(r.top + r.height / 2);
    return !pts.every(([dx, dy]) => e.contains(document.elementFromPoint(x + dx, y + dy)));
  }).map((e) => `${e.className || e.tagName}:${e.dataset.r || e.id || ""}`);
});
const DIALOGS = [["the editor, new", "edit=new"], ["the editor, edit", "edit=open&routine=digest"], ["the check-ins dialog", "view=checkins&bot=juniper&dialog=open"], ["the zone dialog", "view=checkins&bot=otto", '[data-r="zone"]'], ["the delete confirmation", "view=routine&routine=digest&confirm=delete"], ["a routine's menu", "view=routine&routine=digest", '[data-r="more"]']];
for (const [w, h] of [[1440, 900], [1100, 760], [800, 760], [390, 844]]) {
  for (const theme of ["light", "dark"]) {
    const views = ["", "view=routine&routine=digest", "view=week", "view=day", "view=run&routine=digest&run=0", "view=checkins&bot=otto", "transcript=checkin", ...DIALOGS.map(([, q]) => q)];
    for (const [k, view] of views.entries()) {
      const dialog = DIALOGS[k - (views.length - DIALOGS.length)];
      const name = dialog ? dialog[0] : view || "list";
      const pg = await b.newPage({ viewport: { width: w, height: h } });
      pg.on("pageerror", (e) => out.push("PAGEERROR " + e));
      await pg.goto(pageUrl("routines.html") + `?chrome=0&theme=${theme}&${view}`);
      await pg.waitForTimeout(80);
      if (dialog?.[2]) {
        await pg.click(dialog[2]);
        await pg.waitForTimeout(60);
      }
      const r = await pg.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        body: getComputedStyle(document.querySelector("#view")).backgroundColor,
        title: document.querySelector("#view-title")?.textContent || "",
      }));
      check(`${w} ${theme} ${name}: no page overflow, a title`, !r.overflow && !!r.title && r.body !== "rgba(0, 0, 0, 0)", JSON.stringify(r));
      // The week scrolls inside itself below 1100 (section 15); at 1440 and 1100 all seven days fit.
      const c = await clipped(pg, w < 1100);
      check(`${w} ${theme} ${name}: nothing clipped inside its container`, c.length === 0, JSON.stringify(c));
      if (w === 390 && view !== "view=week") {
        const small = await smallTargets(pg);
        check(`390 ${theme} ${name}: every control has a 44 px hit area the pointer reaches`, small.length === 0, JSON.stringify(small));
      }
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
check("phone: the view switch is 44 px tall", (await p.evaluate(() => document.querySelector(".r-seg button").getBoundingClientRect().height >= 44)));
await p.click('.r-head [data-r="new"]');
await p.click('[data-e-kind="days"]');
await p.locator(".r-days").scrollIntoViewIfNeeded();
check("phone: weekday buttons have separate 44 px hit areas", await p.locator(".r-days button").evaluateAll((buttons) =>
  buttons.length === 7 && buttons.every((button) => {
    const rect = button.getBoundingClientRect();
    return rect.width >= 44 && rect.height >= 44 && button.contains(document.elementFromPoint(rect.x + 22, rect.y + 22));
  }),
));
await p.close();
p = await open("view=routine&routine=digest", { width: 800, height: 760 });
check("800: the page header keeps Run now and More only", (await p.evaluate(() => getComputedStyle(document.querySelector(".r-head [data-wide]")).display)) === "none" && (await has(p, '[data-r="more"]')));
await p.close();
p = await open("motion=reduce&view=routine&routine=digest&state=running");
check("reduced motion: nothing runs", (await p.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)) === 0);
await p.close();

const invalid = requests.filter((r) => !(r.method === "cron.add" ? validateCronAddParams(r.params) : r.method === "cron.update" ? validateCronUpdateParams(r.params) : r.method === "cron.remove" ? validateCronRemoveParams(r.params) : r.method === "cron.get" ? validateCronGetParams(r.params) : false));
check(`every request the pages sent (${requests.length}) passes the pinned gateway schema`, requests.length > 30 && invalid.length === 0, JSON.stringify(invalid.slice(0, 2)));
if (process.env.OPENCLAW_PACKAGE_DIR) {
  const dist = join(process.env.OPENCLAW_PACKAGE_DIR, "dist");
  const jobs = (await readdir(dist)).find((file) => /^jobs-[\w-]+\.mjs$/.test(file));
  // OpenClaw 2026.10.6 exports assertSupportedJobSpec as c in its bundled jobs module.
  const { c: assertSupportedJobSpec } = await import(pathToFileURL(join(dist, jobs)).href);
  const invalidJobs = [];
  for (const { query, method, params } of requests) {
    const job = method === "cron.add" ? params : method === "cron.update" && params.id === "reminder"
      ? { sessionTarget: "main", payload: { kind: "systemEvent" }, ...params.patch }
      : null;
    if (!job) continue;
    try {
      assertSupportedJobSpec(job);
    } catch (error) {
      invalidJobs.push({ query, method, error: error.message });
    }
  }
  check("F-189 created jobs and edited reminders pass the gateway's job validator", invalidJobs.length === 0, JSON.stringify(invalidJobs));
}
await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR")) ? 1 : 0);
