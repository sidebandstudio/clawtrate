// Behaviour checks for skills.html (docs/design/skills.md): the library and its
// states, a skill's page, every way a save ends (someone else saving first
// included), a new skill, removing and sharing, the skills a task holds, a
// bot's skills and what it learned, the cards of a bot saving a skill, and the
// phone width. Every check reads visible words, so a changed label fails.
// Run from the repository root:  node docs/design/prototype/tools/checks/skills.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("skills.html") + "?chrome=0&theme=light";
const LIB = "open=settings&section=skills";
const TASK = "bot=juniper&task=j1&panel=open&tab=details";
const BOT = "bot=juniper&panel=open&tab=settings&bview=skills";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name} ${ok ? "" : extra}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => {
    failed += 1;
    out.push("PAGEERROR " + e);
  });
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(250);
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
const dialog = (p) => text(p, "#settings-dialog");
const details = (p) => text(p, ".k-task");
const tab = (p) => text(p, "#panel-settings");
const has = (t, ...words) => words.every((w) => t.includes(w));
const wait = (p, ms = 450) => p.waitForTimeout(ms);
const announced = async (p) => {
  await p.waitForTimeout(80);
  return p.evaluate(() => document.querySelector("#b-announce").textContent);
};
const confirmText = (p) => text(p, "#confirm-dialog");
const typeInto = async (p, sel, value) => {
  await p.fill(sel, value);
  await p.dispatchEvent(sel, "input");
};

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// The library (section 3) ---------------------------------------------------------------------------
let p = await open(LIB);
let t = await dialog(p);
check("S3 Skills sits after Accounts in Settings", await p.evaluate(() => [...document.querySelectorAll(".b-nav-item")].map((n) => n.textContent.trim()).join(",") === "Gateway,Accounts,Skills,Integrations"));
check("S3 the lead says every device of this person sees the same skills", t.includes("Every device of yours connected to this gateway sees the same skills."));
check("S3 groups: Your skills, then Shared on this gateway", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-group")].map((g) => g.textContent).join(",") === "Your skills,Shared on this gateway"));
check("S3 a skill that is off carries the word Off", (await text(p, '[data-k-skill="pack"]')).includes("Off"));
check("S3 a team skill carries the word Team", (await text(p, '[data-k-skill="ridge"]')).includes("Team"));
check("S3 the 64-skill rule and where a task's revision is", t.includes("New tasks start with every skill that is on, up to 64, your own first. A task keeps the revision it started with; see a task's Details."));
check("S3 the list says when it was read, nothing claims to be live", t.includes("As read at 5:41 PM."));
await p.click('[data-k="lib-read"]');
await wait(p, 150);
check("S3 Read again reads again", (await dialog(p)).includes("As read at 5:41 PM") && (await announced(p)).startsWith("Read at"));
check("F-363 no link to a skill anywhere", !(await dialog(p)).includes("Copy link"));
await p.close();

p = await open(LIB + "&multi=1");
t = await dialog(p);
check("S3 with several profiles the lead says skills are each person's", t.includes("Skills are yours on this gateway; other people of this gateway have their own."));
check("S8 another person's shared skill names its owner", (await text(p, '[data-k-skill="river"]')).includes("From Robin Park"));
await p.close();

for (const [state, words] of [
  ["loading", null],
  ["error", ["Couldn't load your skills", "The gateway answered:", "Try again"]],
  ["empty", ["No skills yet", "A skill is a process you want a bot to follow, written once. Save one here, or ask a bot to save what it just did."]],
  ["noprofile", ["No library for this connection", "This connection has no profile on the gateway, so it has no library. The gateway gives a library to a signed-in person."]],
  ["many", ["New sessions select up to 64 enabled skills, personal skills first and then stable ID order."]],
]) {
  p = await open(LIB + "&lib=" + state);
  t = await dialog(p);
  if (state === "loading") check("S3 loading is busy, with shapes", await p.evaluate(() => Boolean(document.querySelector('#settings-dialog [aria-busy="true"] .skeleton'))));
  else check(`S3 ${state}: its words`, has(t, ...words), t.slice(0, 300));
  if (state === "noprofile") check("S3 no profile offers no New skill", !(await p.$('[data-k="new"]')));
  await p.close();
}

p = await open(LIB + "&access=read");
t = await dialog(p);
check("S2 read-only: no New skill, the access bar", !(await p.$('[data-k="new"]')) && t.includes("Read-only. Changing skills needs write access."));
await p.click('[data-k-skill="trail"]');
await wait(p, 150);
check("S2 read-only: fields are read-only, no Save, Share or Remove", (await p.evaluate(() => document.querySelector("#k-body").readOnly && document.querySelector("#k-desc").readOnly)) && !(await p.$('[data-k="save"]')) && !(await p.$('[data-k="share"]')) && !(await p.$('[data-k="remove"]')));
await p.click('#settings-dialog [data-b="request-write"]');
await wait(p, 150);
check("S2 the interactive tier on request: Save and the fields", Boolean(await p.$('[data-k="save"]')) && !(await p.evaluate(() => document.querySelector("#k-body").readOnly)));
await p.close();

// A skill's page (section 4) ------------------------------------------------------------------------
p = await open(LIB);
await p.click('[data-k-skill="trail"]');
await wait(p, 150);
t = await dialog(p);
check("S4 the page opens on its title, the skill's name", (await text(p, "#b-section-title")) === "trail-checklist" && (await p.evaluate(() => document.activeElement?.id)) === "b-section-title");
check("S2 the page says what a skill is, and calls nothing safe", t.includes("A skill is instructions a bot follows. A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it.") && !/\b(safe|verified|trusted)\b/i.test(t));
check("S4 the name is fixed once made, and says why in words", t.includes("A skill's name is set when it is made.") && !(await p.$("#k-slug")));
check("S4 the facts: owner You, a revision, only you", has(t, "OwnerYou", "SharedOnly you") && (await p.evaluate(() => /^[0-9a-f]{12}$/.test(document.querySelector(".k-rev").textContent))));
check("S4 Save starts disabled", await p.evaluate(() => document.querySelector('[data-k="save"]').disabled));
await p.click('[data-k="enable"]');
await wait(p, 400);
check("S4.1 the switch moves after the answer, with its line", (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === "false" && (await dialog(p)).includes("New tasks don't start with it. A task can still attach it."));
await p.click('[data-k="to-list"]');
await wait(p, 150);
check("S4 Back returns focus to the skill's row, now Off", (await p.evaluate(() => document.activeElement?.dataset.kSkill)) === "trail" && (await text(p, '[data-k-skill="trail"]')).includes("Off"));
await p.close();

p = await open(LIB + "&skill=kitchen");
t = await dialog(p);
check("S4 files: each by path, a script marked as one that can run, and kept", has(t, "references/times.md", "scripts/timer.sh", "Can run as a program", "Kept with every save. A bot runs a file only with the tools it is allowed. Editing files isn't in this version."));
await p.close();
p = await open(LIB + "&skill=weather");
t = await dialog(p);
check("S4 needs: from the skill's own text, and what the gateway does with them", has(t, "Programs: curl. Values: WEATHER_API_KEY.", "From the skill's own text. The gateway gives a skill to a bot only when what it needs is there."));
check("S2 an address in a skill is text, never a link", (await p.evaluate(() => document.querySelector("#k-body").value.includes("https://weather.example/forecast"))) && !(await p.$('#settings-dialog a[href*="weather.example"]')));
check("S4 the page never asks for a key's value", !(await p.$('#settings-dialog input[type="password"]')));
await p.close();
p = await open(LIB + "&skill=ridge&access=write");
t = await dialog(p);
check("S4 a team skill below admin is read-only, in the gateway's words", t.includes("Only the skill's owner or a Gateway administrator can change it.") && (await p.evaluate(() => document.querySelector("#k-body").readOnly)));
await p.close();

// Saving (section 5) ---------------------------------------------------------------------------------
p = await open(LIB + "&skill=trail");
await typeInto(p, "#k-body", "1. Check the forecast.\n2. Pack water and a map.");
check("S5 an edit enables Save", !(await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
const before = await text(p, ".k-rev");
await p.click('[data-k="save"]');
check("S5 Saving… while it saves", (await text(p, '[data-k="save"]')) === "Saving…");
await wait(p);
t = await dialog(p);
check("S5 Saved names the new revision and what tasks keep", t.includes("Saved. New tasks start with revision") && t.includes("Tasks that have this skill keep theirs until they are updated.") && (await announced(p)) === "Saved");
check("S5 the facts show the read-back, a new revision", (await p.evaluate(() => document.querySelectorAll(".k-rev")[1]?.textContent)) !== before);
await p.close();

for (const [mode, words, ann] of [
  ["unchanged", ["Nothing to save: the gateway already has this text."], "Nothing to save"],
  ["refused", ["The gateway answered: Skill library authority changed. Refresh and retry. Nothing was saved."], "Couldn't save"],
  ["silent", ["The gateway didn't save this skill and didn't say why. It refuses a skill that contains something that looks like a key or a password; if this one has one, take it out. Nothing was saved."], "Couldn't save"],
]) {
  p = await open(LIB + "&skill=trail&save=" + mode);
  await typeInto(p, "#k-desc", "Use when planning a walk.");
  await p.click('[data-k="save"]');
  await wait(p);
  check(`S5 ${mode}: its words`, has(await dialog(p), ...words) && (await announced(p)) === ann);
  await p.close();
}

p = await open(LIB + "&skill=trail&save=lost");
await typeInto(p, "#k-desc", "Use when planning a walk.");
await p.click('[data-k="save"]');
await wait(p, 400);
check("S5 no answer: says it can't tell, then reads again", (await dialog(p)).includes("Couldn't tell whether it was saved."));
await wait(p, 900);
check("S5 the read-back decides: saved", (await dialog(p)).includes("Checked: the gateway has your text. Saved as revision"));
await p.close();

p = await open(LIB + "&skill=trail&save=removed");
await typeInto(p, "#k-body", "My own steps.");
await p.click('[data-k="save"]');
await wait(p);
check("S5 removed meanwhile: the text is still here", (await dialog(p)).includes("This skill was removed on the gateway. Your text is still here."));
await p.click('[data-k="save-as-new"]');
await wait(p, 150);
check("S5 Save as a new skill keeps the text and asks for a name", (await text(p, "#b-section-title")) === "New skill" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "My own steps." && (await dialog(p)).includes("trail-checklist was removed. Give your text a name to save it as a new skill."));
await p.close();

// Someone else saved first (section 5.1)
p = await open(LIB + "&skill=trail&save=conflict");
await typeInto(p, "#k-body", "My edit of the checklist.");
await p.click('[data-k="save"]');
await wait(p);
t = await dialog(p);
check("S5.1 someone else saved first: the note and both versions", has(t, "Someone else saved this skill at 5:44 PM, after you opened it. Your edit isn't saved. Compare them, then choose.", "On the gateway now", "Your edit", "Theirs stays as an earlier revision on the gateway.") && (await announced(p)) === "Someone else saved this skill");
check("S5.1 theirs is shown as read, yours is kept", (await text(p, "[data-k-theirs]")).includes("a head torch") && (await p.evaluate(() => document.querySelector("#k-body").value)) === "My edit of the checklist.");
check("S5.1 nothing was saved silently: no Save in the foot", !(await p.$('[data-k="save"]')));
await p.click('[data-k="use-theirs"]');
await wait(p, 150);
check("S5.1 Use theirs asks before the edit is deleted", has(await confirmText(p), "Discard your edit?", "Your text is deleted from this page. The gateway's version stays."));
await p.click('#confirm-dialog [data-b="confirm-cancel"]');
await wait(p, 100);
check("S5.1 Cancel keeps the edit", (await p.evaluate(() => document.querySelector("#k-body").value)) === "My edit of the checklist.");
await p.click('[data-k="save-mine"]');
await wait(p);
check("S5.1 Save my edit saves on their revision", (await dialog(p)).includes("Saved. New tasks start with revision") && !(await dialog(p)).includes("On the gateway now"));
await p.close();

p = await open(LIB + "&skill=trail&save=conflict");
await typeInto(p, "#k-body", "Another edit.");
await p.click('[data-k="save"]');
await wait(p);
await p.click('[data-k="use-theirs"]');
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 150);
check("S5.1 Use theirs, confirmed: the page shows the gateway's version", (await p.evaluate(() => document.querySelector("#k-body").value)).includes("a head torch") && (await dialog(p)).includes("Showing the gateway's version, revision"));
await p.close();

// Leaving with unsaved text
p = await open(LIB + "&skill=trail");
await typeInto(p, "#k-body", "Unsaved.");
await p.click('[data-k="to-list"]');
await wait(p, 120);
check("S5 leaving with unsaved text asks", has(await confirmText(p), "Leave without saving?", "Your edit to trail-checklist is lost."));
await p.click('#confirm-dialog [data-b="confirm-cancel"]');
await wait(p, 100);
check("S5 Cancel stays on the page with the text", (await text(p, "#b-section-title")) === "trail-checklist" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "Unsaved.");
await p.click('#settings-dialog .b-section > [data-b="close"]');
await wait(p, 120);
check("S5 closing Settings with unsaved text asks too", (await confirmText(p)).includes("Leave without saving?") && (await p.evaluate(() => document.querySelector("#settings-dialog").open)));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 120);
check("S5 Leave closes it", !(await p.evaluate(() => document.querySelector("#settings-dialog").open)));
await p.close();

// A new skill (section 6) -----------------------------------------------------------------------------
p = await open(LIB);
await p.click('[data-k="new"]');
await wait(p, 150);
check("S6 New skill: the title, the name rule, focus on Name", (await text(p, "#b-section-title")) === "New skill" && (await dialog(p)).includes("Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.") && (await p.evaluate(() => document.activeElement?.id)) === "k-slug");
await typeInto(p, "#k-slug", "Trail Notes");
check("S6 an invalid name is named as such, and Save stays disabled", (await p.evaluate(() => document.querySelector("#k-slug-help").className)) === "b-field-error" && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await typeInto(p, "#k-slug", "trail-notes");
await typeInto(p, "#k-desc", "Use when writing up a walk.");
check("S6 no instructions: Save stays disabled, and says what is missing", (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)) && (await text(p, "#k-body-help")) === "Write what the bot should do.");
await typeInto(p, "#k-body", "Note the distance and the time.");
await p.click('[data-k="save"]');
await wait(p);
check("S6 saved: the page becomes the skill's page", (await text(p, "#b-section-title")) === "trail-notes" && (await dialog(p)).includes("Saved. New tasks start with it."));
await p.click('[data-k="to-list"]');
await wait(p, 120);
check("S6 the list has it", Boolean(await p.$('[data-k-skill="new-trail-notes"]')));
await p.close();

p = await open(LIB);
await p.click('[data-k="new"]');
await typeInto(p, "#k-slug", "trail-checklist");
await typeInto(p, "#k-desc", "Use when walking.");
await typeInto(p, "#k-body", "Walk.");
await p.click('[data-k="save"]');
await wait(p);
check("S6 a name already taken, under the field", (await text(p, "#k-slug-help")) === "You already have a skill called trail-checklist. Choose another name." && (await p.evaluate(() => document.activeElement?.id)) === "k-slug");
await p.close();

p = await open(LIB + "&skill=new&big=1");
await typeInto(p, "#k-slug", "long-one");
await typeInto(p, "#k-desc", "Use when long.");
check("S6 over the gateway's limit: said before sending", (await text(p, "#k-body-help")) === "Too long for the gateway: 1,048,576 characters at most, frontmatter included." && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await p.close();

// Removing (section 7) and sharing (section 8) -------------------------------------------------------
p = await open(LIB + "&skill=trail");
await p.click('[data-k="remove"]');
await wait(p, 120);
check("S7 Remove asks, and says what tasks keep", has(await confirmText(p), "Remove trail-checklist?", "It leaves your library and new tasks won't start with it. Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 150);
check("F-362 S7 removed: said from the read-back, the row gone", (await dialog(p)).includes("Removed. trail-checklist is no longer in your library.") && !(await p.$('[data-k-skill="trail"]')) && (await announced(p)) === "Removed");
await p.close();

p = await open(LIB + "&skill=kitchen");
t = await dialog(p);
check("F-363 S8 not shared: what sharing does, on this gateway only", has(t, "Share on this gateway", "Other people of this gateway can then see it and their new tasks start with it. Nothing leaves the gateway.", "No one else has a profile on this gateway yet, so no one else sees it."));
await p.click('[data-k="share"]');
await wait(p, 400);
t = await dialog(p);
check("F-363 S8 shared: the answer's state, Stop sharing offered", has(t, "Shared on this gateway. The gateway lists it with the team's skills.", "SharedShared on this gateway", "Stop sharing", "Their tasks that have it keep it when you stop sharing.") && (await announced(p)) === "Shared on this gateway");
await p.click('[data-k="to-list"]');
await wait(p, 120);
check("F-363 S3 the row carries Shared", (await text(p, '[data-k-skill="kitchen"]')).includes("Shared"));
await p.click('[data-k-skill="kitchen"]');
await p.click('[data-k="share"]');
await wait(p, 400);
check("F-363 S8 Stop sharing", (await dialog(p)).includes("No longer shared. Only you have it in your library.") && (await announced(p)) === "No longer shared");
await p.close();

// Skills in a task (section 9) -----------------------------------------------------------------------
p = await open(TASK);
t = await details(p);
check("S9 the task's skills, each with its revision", has(t, "Skills in this task", "trail-checklist", "kitchen-timer", "weather-check") && (await p.evaluate(() => document.querySelectorAll(".k-pin .k-rev").length)) === 3);
check("S9 a skill whose needs aren't met: Not given, and why", has(t, "Not given", "The gateway says what it needs isn't there."));
check("S9 nothing outdated: no Update", !(await p.$('[data-k="refresh"]')));
await p.click('[data-k-pin="trail"]');
await wait(p, 120);
check("S9 a held revision opens read-only, named as the task's", has(await details(p), "the one this task has", "A skill is instructions a bot follows.") && !(await p.$(".k-held textarea")));
await p.click('[data-k="held-back"]');
await wait(p, 120);
check("S9 Back returns to the list", (await details(p)).includes("Skills in this task") && (await p.evaluate(() => Boolean(document.activeElement?.dataset.kPin))));
await p.click('[data-k="attach-open"]');
await wait(p, 100);
check("S9 Attach lists only skills the task doesn't have", has(await details(p), "pack-list", "ridge-safety") && !(await p.$('.k-attach-item[data-value="trail"]')));
await p.click('.k-attach-item[data-value="ridge"]');
await wait(p, 400);
check("S9 attached: from the next turn", has(await details(p), "Attached. From the next turn.") && Boolean(await p.$('[data-k-pin="ridge"]')));
await p.click('[data-k="detach"][data-value="kitchen"]');
await wait(p, 400);
check("S9 detached: from the next turn", has(await details(p), "Detached. From the next turn.") && !(await p.$('[data-k-pin="kitchen"]')));
await p.close();

p = await open(TASK + "&pins=outdated&running=1");
t = await details(p);
check("S9 a newer revision saved: the tag, and Update for the whole task", has(t, "Newer revision", "Update to the latest revisions", "Updates every skill in this task."));
await p.click('[data-k="refresh"]');
await wait(p, 400);
t = await details(p);
check("F-361 S9 updated: from the next turn; the running turn keeps its own", has(t, "Updated to the latest revisions. From the next turn. The turn running now keeps the skills it started with.") && !t.includes("Newer revision"));
await p.close();

p = await open(TASK + "&pins=removed");
t = await details(p);
check("S9 a removed skill blocks Update, and says so", has(t, "Removed", "Detach removed skills first.") && (await p.evaluate(() => document.querySelector('[data-k="refresh"]').disabled)));
await p.click('[data-k="detach"][data-value="gone"]');
await wait(p, 120);
check("S9 detaching a removed skill says it can't come back", (await confirmText(p)).includes("It was removed from your library, so it can't be attached again."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 400);
check("S9 then Update is offered", !(await p.evaluate(() => document.querySelector('[data-k="refresh"]').disabled)));
await p.close();

for (const [state, words] of [
  ["none", "This task has no skills from your library."],
  ["error", "Couldn't load this task's skills. The gateway answered: Session not found."],
]) {
  p = await open(TASK + "&pins=" + state);
  check(`S9 ${state}: its words`, (await details(p)).includes(words));
  await p.close();
}
p = await open(TASK + "&list=only");
check("S9 a skill the bot's list leaves out: Not given, and why", (await details(p)).includes("Juniper's skill list doesn't include it."));
await p.close();
p = await open(TASK + "&access=read");
t = await details(p);
check("S9 read-only: the skills, no Detach or Attach", t.includes("Changing a task's skills needs write access.") && !(await p.$('.k-task [data-k="detach"]')) && !(await p.$('[data-k="attach-open"]')));
await p.close();

// A bot's skills (section 10) ------------------------------------------------------------------------
p = await open("bot=juniper&panel=open&tab=settings");
check("S10 the Tools group has a Skills row with the list's state", (await text(p, '#panel-settings [data-bs="skills"]')).includes("Every skill"));
await p.click('#panel-settings [data-bs="skills"]');
await wait(p, 150);
t = await tab(p);
check("S10 the page: three choices, Every skill chosen", has(t, "Juniper's skills", "Which skills Juniper is given") && (await p.evaluate(() => document.querySelector('[data-k-choice="all"]').getAttribute("aria-checked"))) === "true");
check("S10 learned skills are given whatever the list says; a list is not a command boundary", t.includes("Skills Juniper learned are given whatever this says. This decides what Juniper is given; it doesn't stop Juniper's commands from reading files."));
await p.click('[data-k-choice="none"]');
await p.click('[data-k="list-save"]');
await wait(p);
t = await tab(p);
check("F-199 S10 saved: from each task's next turn; a running turn keeps its own", t.includes("Saved. From each task's next turn, Juniper is given these. A turn running now keeps the skills it started with."));
await p.click('#panel-settings [data-bs="main"]');
await wait(p, 150);
check("S10 the row reads None after the read-back", (await text(p, '#panel-settings [data-bs="skills"]')).includes("None"));
await p.close();

p = await open(BOT + "&list=only");
t = await tab(p);
check("S10 Only these: your library by name, with the command name the gateway matches", has(t, "Your library", "On the gateway", "trail-checklist") && /s_trail_che_[0-9a-f]{20}/.test(t));
while (await p.$("#panel-settings input[type=checkbox]:checked")) await p.click("#panel-settings input[type=checkbox]:checked");
await wait(p, 100);
check("S10 nothing checked: says so, and Save is disabled", (await tab(p)).includes("Check at least one skill, or choose None.") && (await p.evaluate(() => document.querySelector('[data-k="list-save"]').disabled)));
await p.close();

p = await open(BOT + "&list=unknown");
t = await tab(p);
check("S10 a name that matches nothing: listed apart, and what it gives", has(t, "Not on this gateway", "s_old_route_9b1c2d3e4f5a6b7c8d9e", "A name that matches no skill gives Juniper nothing."));
await p.click('[data-k="list-drop"]');
await wait(p, 120);
check("S10 Remove from the list", !(await tab(p)).includes("s_old_route_9b1c2d3e4f5a6b7c8d9e"));
await p.close();

p = await open(BOT + "&cfg=conflict");
await p.click('[data-k-choice="none"]');
await p.click('[data-k="list-save"]');
await wait(p);
check("S10 someone else changed the settings: nothing written, what the gateway has now", (await tab(p)).includes("Someone else changed Juniper's settings. This shows what the gateway has now."));
await p.close();

p = await open(BOT + "&access=write");
t = await tab(p);
check("S10 below admin: the value, no Save, the access bar", t.includes("Admin access needed. Changing which skills Juniper is given changes the gateway's settings.") && !(await p.$('[data-k="list-save"]')) && (await p.evaluate(() => document.querySelector('[data-k-choice="all"]').getAttribute("aria-disabled"))) === "true");
await p.close();

// What a bot learned (section 10.2)
p = await open(BOT);
t = await tab(p);
check("S10.2 learned: what the gateway records, and nothing more", has(t, "What Juniper learned", "Skills Juniper saved for itself on the gateway. They are given to Juniper in every task.", "Saved by Juniper in Weekend walk checklist, 3:04 PM", "Learning on its ownOn"));
await p.click('[data-k-learned="trail-checklist"]');
await wait(p, 150);
t = await tab(p);
check("S10.2 a learned skill opens read-only, with its changes", has(t, "Its text, as the gateway keeps it", "There is no editor for a learned skill: only Juniper changes it.", "SKILL.md") && !(await p.$("#panel-settings textarea")));
await p.click('[data-k="archive"]');
await wait(p, 120);
check("S10.2 Archive asks, and says it can be restored", has(await confirmText(p), "Archive trail-checklist?", "Juniper stops being given it. The gateway keeps it, and you can restore it."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 200);
t = await tab(p);
check("F-362 S10.2 archived: in Archived, by a person", has(t, "Archived. trail-checklist is in Archived.", "Archived") && (await announced(p)) === "Archived");
await p.click('[data-k="restore"]');
await wait(p, 400);
check("S10.2 Restore", (await tab(p)).includes("Restored. trail-checklist is given to Juniper again.") && (await tab(p)).includes("Restored by a person"));
await p.close();

p = await open(BOT + "&learned=empty");
check("S10.2 nothing learned: its words", (await tab(p)).includes("Nothing learned yet"));
await p.close();
p = await open("bot=juniper&panel=open&tab=settings&bview=learned&access=write");
check("S10.2 below admin: no Archive, the access bar", !(await p.$('[data-k="archive"]')) && (await tab(p)).includes("Archiving a skill Juniper learned needs admin access."));
await p.close();

// The cards (section 12) ------------------------------------------------------------------------------
p = await open("bot=juniper&task=jlearn");
const cards = await p.evaluate(() => [...document.querySelectorAll(".k-card summary")].map((s) => s.getAttribute("aria-label")));
check("F-198 S12 the three cards, in the family's words", cards.join("|") === "Saved a skill trail-checklist, Saved to your skills|Couldn't save a skill trail-checklist, Failed|Learned a skill trail-checklist, Learned", cards.join("|"));
await p.click("#k-card-saved summary");
await wait(p, 100);
check("S12 opened: the instructions as plain text", await p.evaluate(() => Boolean(document.querySelector("#k-card-saved[open] pre.k-plain")) && !document.querySelector("#k-card-saved a")));
check("S12 a saved skill isn't in this task yet, and says so", (await text(p, "#k-card-attach")).includes("New tasks start with it. This task doesn't have it yet."));
await p.click('[data-k="card-attach"]');
await wait(p, 400);
check("S12 Use in this task: attached from the next turn", (await text(p, "#k-card-attach")) === "Attached. This task has it from the next turn.");
await p.click("#k-card-refused summary");
await wait(p, 100);
check("S12 a refused call shows the gateway's text as text", (await text(p, "#k-card-refused")).includes('Validation failed for tool "skill_workshop"'));
await p.click('[data-k="card-open"]');
await wait(p, 200);
check("S12 Open in Skills opens the skill's page", (await p.evaluate(() => document.querySelector("#settings-dialog").open)) && (await text(p, "#b-section-title")) === "trail-checklist");
await p.close();
p = await open("bot=juniper&task=jlearn");
await p.click("#k-card-learned summary");
await p.click('[data-k="card-learned"]');
await wait(p, 250);
check("S12 Open in Juniper's skills opens the learned skill", (await tab(p)).includes("Its text, as the gateway keeps it"));
await p.close();

// Phone and themes (section 13) -----------------------------------------------------------------------
p = await open(LIB + "&skill=trail&save=conflict&width=phone", { width: 390, height: 844 });
await typeInto(p, "#k-body", "Phone edit.");
await p.click('[data-k="save"]');
await wait(p);
check("S13 phone: the comparison stacks, the gateway's first", await p.evaluate(() => {
  const [a, c] = document.querySelectorAll(".k-compare > section");
  return a && c && a.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 1 && a.querySelector("h4").textContent === "On the gateway now";
}));
check("S13 phone: nothing scrolls sideways", await p.evaluate(() => document.querySelector(".b-section-body").scrollWidth <= document.querySelector(".b-section-body").clientWidth + 1));
await p.close();
p = await open(LIB + "&width=phone", { width: 390, height: 844 });
check("S13 phone: rows are 64 px", await p.evaluate(() => Math.round(document.querySelector(".k-row").getBoundingClientRect().height) >= 64));
await p.close();
for (const width of ["1100", "800"]) {
  p = await open(LIB + "&skill=trail&save=conflict&width=" + width);
  await typeInto(p, "#k-body", "An edit at " + width + ".");
  await p.click('[data-k="save"]');
  await wait(p);
  check(`S13 ${width}: the comparison shows both versions, nothing scrolls sideways`, (await dialog(p)).includes("On the gateway now") && (await p.evaluate(() => document.querySelector(".b-section-body").scrollWidth <= document.querySelector(".b-section-body").clientWidth + 1)));
  await p.close();
  p = await open(TASK + "&pins=outdated&width=" + width);
  check(`S13 ${width}: the task's skills fit the pane`, (await details(p)).includes("Newer revision") && (await p.evaluate(() => { const s = document.querySelector(".k-task"); return s.scrollWidth <= s.clientWidth + 1; })));
  await p.close();
}
p = await open(TASK + "&theme=dark&pins=outdated");
check("S13 dark: the task's skills render", (await details(p)).includes("Newer revision"));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
