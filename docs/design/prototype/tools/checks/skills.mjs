// Behaviour checks for skills.html (docs/design/skills.md): the library and its
// states, a skill's page, every way a write ends (pending, answered, refused,
// unanswered, read back), a new skill, removing and sharing, the skills a task
// has, a bot's skill filter and what it learned, the cards of a bot saving a
// skill, and the four widths. Every check reads visible words or the gateway
// stand-in's own state, so a changed label or a claim the read doesn't support
// fails. Run from the repository root:  node docs/design/prototype/tools/checks/skills.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("skills.html") + "?chrome=0&theme=light";
const LIB = "open=settings&section=skills";
const TASK = "bot=juniper&task=j1&panel=open&tab=details";
const BOT = "bot=juniper&panel=open&tab=settings&bview=skills";
const SETTLE = 800; // a write's answer and its read
const b = await chromium.launch();
const out = [];
const outbound = [];
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
  p.on("request", (r) => /^https?:/i.test(r.url()) && outbound.push(r.url()));
  await p.goto(base + (query ? "&" + query : ""));
  await p.waitForTimeout(250);
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
const dialog = (p) => text(p, "#settings-dialog");
const details = (p) => text(p, ".k-task");
const tab = (p) => text(p, "#panel-settings");
const has = (t, ...words) => words.every((w) => t.includes(w));
const wait = (p, ms = SETTLE) => p.waitForTimeout(ms);
const announced = async (p) => {
  await p.waitForTimeout(80);
  return p.evaluate(() => document.querySelector("#b-announce").textContent);
};
const confirmText = (p) => text(p, "#confirm-dialog");
const typeInto = async (p, sel, value) => {
  await p.fill(sel, value);
  await p.dispatchEvent(sel, "input");
};
const gwRead = (p, id) => p.evaluate((i) => window.skills.read(i), id);
const fits = (p, sel) => p.evaluate((s) => [...document.querySelectorAll(s)].every((el) => el.scrollWidth <= el.clientWidth + 1), sel);
const oneColumn = (p) =>
  p.evaluate(() => {
    const [a, c] = document.querySelectorAll(".k-compare > section");
    return Boolean(a && c && a.getBoundingClientRect().bottom <= c.getBoundingClientRect().top + 1 && a.querySelector("h4").textContent === "On the gateway now");
  });

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// The library (section 3) ---------------------------------------------------------------------------
let p = await open(LIB);
let t = await dialog(p);
check("S3 Skills sits after Accounts in Settings", await p.evaluate(() => [...document.querySelectorAll(".b-nav-item")].map((n) => n.textContent.trim()).join(",") === "Gateway,Accounts,Skills,Integrations"));
check("S3 R6 the lead claims nothing about a person's other devices", t.includes("Skills in your library on this gateway, and skills others share here. A library skill reaches a bot only in a task that has it.") && !t.includes("Every device"));
check("S3 R6 an admin sees others' skills, unshared ones marked", (await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-group")].map((g) => g.textContent).join(","))) === "Your skills,Others' skills on this gateway" && (await text(p, '[data-k-skill="elsewhere"]')).includes("From Robin Park, not shared"));
check("S3 R3 a skill left out of defaults says so", (await text(p, '[data-k-skill="pack"]')).includes("Not in defaults"));
check("S3 a team skill carries the word Team", (await text(p, '[data-k-skill="ridge"]')).includes("Team"));
check("S3 R3 who a task begins with, exactly", t.includes("A task a person starts begins with up to 64 of the skills included in defaults, their own first. A task a bot starts begins with none. A task keeps the revisions it began with until it is updated; see a task's Details."));
check("S3 the list says when it was read", t.includes("As read at 5:41 PM."));
await p.click('[data-k="lib-read"]');
await wait(p, 150);
check("S3 Read again reads again", (await announced(p)).startsWith("Read at"));
check("F-363 no link to a skill anywhere", !(await dialog(p)).includes("Copy link"));
await p.close();

p = await open(LIB + "&access=write");
check("S3 R6 below admin, another person's unshared skill isn't listed", (await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-group")].map((g) => g.textContent).join(","))) === "Your skills,Shared on this gateway" && !(await p.$('[data-k-skill="elsewhere"]')));
await p.close();
p = await open(LIB + "&multi=1&access=write");
check("S8 another person's shared skill names its owner", (await text(p, '[data-k-skill="river"]')).includes("From Robin Park"));
await p.close();

for (const [state, words] of [
  ["error", ["Couldn't load your skills", "The gateway answered:", "Try again"]],
  ["empty", ["No skills yet", "A skill is a process you want a bot to follow, written once. Save one here, or ask a bot to save what it just did."]],
  ["many", ["New sessions select up to 64 enabled skills, personal skills first and then stable ID order."]],
]) {
  p = await open(LIB + "&lib=" + state);
  check(`S3 ${state}: its words`, has(await dialog(p), ...words));
  await p.close();
}
p = await open(LIB + "&lib=loading");
check("S3 loading is busy, with shapes", await p.evaluate(() => Boolean(document.querySelector('#settings-dialog [aria-busy="true"] .skeleton'))));
await p.close();
p = await open(LIB + "&lib=noprofile");
t = await dialog(p);
check("S3 R6 no personal library: said from the list's profile, shared skills still listed, no New skill", t.includes("This connection has no personal library: the gateway's list says it has no profile. Skills shared on this gateway are still listed.") && Boolean(await p.$('[data-k-skill="ridge"]')) && !(await p.$('[data-k="new"]')));
await p.close();
p = await open(LIB + "&banner=offline");
check("S2 R4 offline: the list as read, New skill disabled", (await dialog(p)).includes("Not connected to the gateway. This is the list as read at 5:41 PM") && (await p.evaluate(() => document.querySelector('[data-k="new"]').disabled)));
await p.close();

p = await open(LIB + "&access=read");
t = await dialog(p);
check("S2 read-only: no New skill, the access bar", !(await p.$('[data-k="new"]')) && t.includes("Read-only. Changing skills needs write access."));
await p.click('[data-k-skill="trail"]');
await wait(p, 150);
check("S2 R8 read-only: values are wrapping text, no field, no Save, Share or Remove", !(await p.$("#k-desc")) && !(await p.$("#k-body")) && (await fits(p, "#k-desc-text")) && !(await p.$('[data-k="save"]')) && !(await p.$('[data-k="share"]')) && !(await p.$('[data-k="remove"]')));
await p.click('#settings-dialog [data-b="request-write"]');
await wait(p, 150);
check("S2 the interactive tier on request: Save and the fields", Boolean(await p.$('[data-k="save"]')) && Boolean(await p.$("#k-body")));
await p.close();

// A skill's page (section 4) ------------------------------------------------------------------------
p = await open(LIB);
await p.click('[data-k-skill="trail"]');
await wait(p, 150);
t = await dialog(p);
check("S4 the page opens on its title, the skill's name", (await text(p, "#b-section-title")) === "trail-checklist" && (await p.evaluate(() => document.activeElement?.id)) === "b-section-title");
check("S2 the page says what a skill is, and calls nothing safe", t.includes("A skill is instructions a bot follows. A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it.") && !/\b(safe|verified|trusted)\b/i.test(t));
check("S4 the name is fixed in Clawtrate, and says so", t.includes("A skill's name is set when it is made in Clawtrate.") && !(await p.$("#k-slug")));
check("S4 R6 the facts: owner You, a revision, Not shared", has(t, "OwnerYou", "SharedNot shared") && !t.includes("Only you") && (await p.evaluate(() => /^[0-9a-f]{12}$/.test(document.querySelector(".k-rev").textContent))));
check("S2 angle brackets in instructions stay text", (await p.evaluate(() => document.querySelector("#k-body").value)).includes("<important>"));
check("S4 Save starts disabled", await p.evaluate(() => document.querySelector('[data-k="save"]').disabled));
await p.click('[data-k="enable"]');
await wait(p, 150);
check("S4.1 R4 the switch waits for the read: pending, not moved, nothing announced", (await dialog(p)).includes("Saving…") && (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === "true");
await wait(p);
check("S4.1 R3 then moves to the read's value, with its line", (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === "false" && (await dialog(p)).includes("Tasks don't begin with it. It can still be attached to a task.") && (await gwRead(p, "trail")).enabled === false);
await p.click('[data-k="to-list"]');
await wait(p, 150);
check("S4 Back returns focus to the skill's row, now Not in defaults", (await p.evaluate(() => document.activeElement?.dataset.kSkill)) === "trail" && (await text(p, '[data-k-skill="trail"]')).includes("Not in defaults"));
await p.close();

p = await open(LIB + "&skill=kitchen");
t = await dialog(p);
check("S4 files: each by path, a script marked as one that can run, and kept", has(t, "references/times.md", "scripts/timer.sh", "Can run as a program", "Kept with every save. A bot runs a file only with the tools it is allowed. Editing files isn't in this version."));
await p.close();
p = await open(LIB + "&skill=weather");
t = await dialog(p);
check("S4 R1 its other settings: shown exactly as read, kept on save", has(t, "Its other settings", 'user-invocable: false metadata: {"openclaw":{"requires":{"bins":["curl"],"env":["WEATHER_API_KEY"]}}}', "Saving keeps them exactly as they are; this page doesn't change them."));
check("S4 needs: from the skill's own text", has(t, "Programs: curl. Values: WEATHER_API_KEY.", "From the skill's own text. The gateway gives a skill to a bot only when what it needs is there."));
check("S2 an address in a skill is text, never a link, and the page never asks for a key", (await p.evaluate(() => document.querySelector("#k-body").value.includes("https://weather.example/forecast"))) && !(await p.$('#settings-dialog a[href*="weather.example"]')) && !(await p.$('#settings-dialog input[type="password"]')));
await typeInto(p, "#k-body", "Call the forecast service and say it in one line.");
await p.click('[data-k="save"]');
await wait(p);
let g = await gwRead(p, "weather");
check("F-361 S5 R1 a text-only save keeps every other frontmatter line on the gateway", g.extra.join("\n") === 'user-invocable: false\nmetadata: {"openclaw":{"requires":{"bins":["curl"],"env":["WEATHER_API_KEY"]}}}' && g.body === "Call the forecast service and say it in one line.");
await p.close();
p = await open(LIB + "&skill=kitchen");
await typeInto(p, "#k-desc", "Use when timing anything in the kitchen.");
await p.click('[data-k="save"]');
await wait(p);
check("S5 R1 a save keeps the files of its base", (await gwRead(p, "kitchen")).files.map((f) => f.path).join(",") === "references/times.md,scripts/timer.sh");
await p.close();
p = await open(LIB + "&skill=notes");
t = await dialog(p);
check("S4 R1 a skill that can't be round-tripped is read-only, shown as kept", t.includes("Clawtrate can't change this skill's text without changing how it is written: its Use when… isn't on one line. It is shown as the gateway keeps it.") && (await text(p, "#k-raw-md")).includes("description: >") && !(await p.$("#k-body")) && !(await p.$('[data-k="save"]')));
await p.close();
p = await open(LIB + "&skill=ridge&access=write");
check("S4 a team skill below admin is read-only, in the gateway's words", (await dialog(p)).includes("Only the skill's owner or a Gateway administrator can change it.") && !(await p.$("#k-body")));
await p.close();

// Saving (section 5) ---------------------------------------------------------------------------------
p = await open(LIB + "&skill=trail");
await typeInto(p, "#k-body", "1. Check the forecast.\n2. Pack water and a map.");
check("S5 an edit enables Save", !(await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await p.click('[data-k="save"]');
await wait(p, 100);
t = await dialog(p);
check("S5 R4 pending: Saving…, and no outcome before the read", t.includes("Saving…") && !t.includes("Saved revision") && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await typeInto(p, "#k-body", "1. Check the forecast.\n2. Pack water and a map.\n3. Typed while it saved.");
await wait(p);
t = await dialog(p);
g = await gwRead(p, "trail");
check("S5 R4 what was sent is what was there at the click; later typing is kept", g.body === "1. Check the forecast.\n2. Pack water and a map." && (await p.evaluate(() => document.querySelector("#k-body").value)).endsWith("Typed while it saved.") && t.includes("You typed more after you chose Save; that isn't saved."));
check("F-361 S5 R3 Saved names the revision the read shows, and what new tasks get", t.includes(`Saved revision ${g.rev.slice(0, 12)}. New tasks that begin with this skill get this revision. Tasks that have it keep theirs until they are updated.`) && !t.includes("New tasks start with revision") && (await announced(p)) === "Saved");
await p.close();

p = await open(LIB + "&skill=pack");
await typeInto(p, "#k-body", "Pack lighter.");
await p.click('[data-k="save"]');
await wait(p);
check("S5 R3 a skill left out of defaults: new tasks don't begin with it", (await dialog(p)).includes("It isn't included in defaults, so new tasks don't begin with it."));
await p.close();

for (const [mode, words, ann] of [
  ["unchanged", ["Nothing to save: the gateway already has this text."], "Nothing to save"],
  ["refused", ["The gateway answered: Skill library authority changed. Refresh and retry. Reading the skill again: revision", "unchanged. Your text is still here."], "Couldn't save"],
  ["silent", ["The gateway answered that it couldn't complete the save, without saying why. It refuses a skill that contains something that looks like a key or a password; if this one has one, take it out. Reading the skill again: revision"], "Couldn't save"],
  ["superseded", ["The gateway answered: saved as revision", "Reading it again found revision", "saved after it; the page shows that one. Yours stays as an earlier revision."], "Saved, then changed elsewhere"],
  ["readfail", ["The gateway answered: saved as revision", "Reading the skill again failed, so the facts below are as read before.", "Read again"], "Saved, not read back"],
]) {
  p = await open(LIB + "&skill=trail&save=" + mode);
  if (mode === "unchanged") {
    await typeInto(p, "#k-body", "x");
    await typeInto(p, "#k-body", (await gwRead(p, "trail")).body);
    await p.evaluate(() => (document.querySelector('[data-k="save"]').disabled = false));
  } else await typeInto(p, "#k-desc", "Use when planning a walk.");
  await p.click('[data-k="save"]');
  await wait(p);
  check(`S5 R4 ${mode}: its words, from the read`, has(await dialog(p), ...words) && (await announced(p)) === ann, (await dialog(p)).slice(0, 400));
  await p.close();
}

for (const [mode, matches] of [
  ["lost", "matches"],
  ["lostnot", "doesn't match"],
]) {
  p = await open(LIB + "&skill=trail&save=" + mode);
  await typeInto(p, "#k-desc", "Use when planning a walk.");
  await p.click('[data-k="save"]');
  await wait(p, 150);
  check(`S5 R4 ${mode}: nothing said before the read`, !(await dialog(p)).includes("Couldn't tell") && !(await dialog(p)).includes("Saved"));
  await wait(p);
  t = await dialog(p);
  check(`S5 R4 ${mode}: only what the read found, no claim of saved, no retry`, has(t, "Couldn't tell whether your save reached the gateway. Reading the skill again found revision", `its text ${matches} what you sent. Which save wrote it isn't known. Your text is still here`) && !t.includes("Saved revision") && (await p.evaluate(() => document.querySelector("#k-desc").value)) === "Use when planning a walk.");
  await p.close();
}

p = await open(LIB + "&skill=trail&save=removed");
await typeInto(p, "#k-body", "My own steps.");
await p.click('[data-k="save"]');
await wait(p);
check("S5 removed meanwhile: told by its code, the text is still here", (await dialog(p)).includes("This skill was removed on the gateway. Your text is still here."));
await p.click('[data-k="save-as-new"]');
await wait(p, 150);
t = await dialog(p);
check("S6 R1 Save text as a new skill: named as such, says what isn't copied", (await text(p, "#b-section-title")) === "Save text as a new skill" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "My own steps." && t.includes("The removed skill's other settings and files aren't copied: the new skill has only this Use when… and these instructions."));
await p.close();

// Someone else saved first (section 5.1)
p = await open(LIB + "&skill=trail&save=conflict");
await typeInto(p, "#k-body", "My edit of the checklist.");
await p.click('[data-k="save"]');
await wait(p);
t = await dialog(p);
g = await gwRead(p, "trail");
check("S5.1 someone else saved first: the note and both versions", has(t, "Someone else saved this skill at 5:44 PM, after you opened it. Your edit isn't saved. Compare them, then choose.", "On the gateway now", "Your edit", "Theirs stays as an earlier revision on the gateway.") && (await announced(p)) === "Someone else saved this skill");
check("S5.1 theirs is shown whole, as the gateway has it; yours is kept", (await p.evaluate(() => document.querySelector("[data-k-theirs]").textContent)) === g.body && (await text(p, "[data-k-theirs-desc]")) === g.description && (await p.evaluate(() => document.querySelector("#k-body").value)) === "My edit of the checklist.");
check("S5.1 nothing was saved silently: no Save in the foot", !(await p.$('[data-k="save"]')));
await p.click('[data-k="use-theirs"]');
await wait(p, 150);
check("S5.1 Use theirs asks before the edit is deleted", has(await confirmText(p), "Discard your edit?", "Your text is deleted from this page. The gateway's version stays."));
await p.click('#confirm-dialog [data-b="confirm-cancel"]');
await wait(p, 100);
check("S5.1 Cancel keeps the edit", (await p.evaluate(() => document.querySelector("#k-body").value)) === "My edit of the checklist.");
await p.click('[data-k="save-mine"]');
await wait(p);
check("S5.1 Save my edit saves on their revision", (await dialog(p)).includes("Saved revision") && !(await dialog(p)).includes("On the gateway now") && (await gwRead(p, "trail")).body === "My edit of the checklist.");
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
await p.focus("#k-body");
await p.keyboard.press("Escape");
await wait(p, 150);
check("S5 R8 Escape with unsaved text asks the same, and leaves Settings open", (await confirmText(p)).includes("Leave without saving?") && (await p.evaluate(() => document.querySelector("#settings-dialog").open)));
await p.click('#confirm-dialog [data-b="confirm-cancel"]');
await wait(p, 100);
await p.click('#settings-dialog [data-b-section="accounts"]');
await wait(p, 120);
check("S5 R8 choosing another section with unsaved text asks too", (await confirmText(p)).includes("Leave without saving?") && (await text(p, "#b-section-title")) === "trail-checklist");
await p.click('#confirm-dialog [data-b="confirm-cancel"]');
await wait(p, 100);
await p.click('#settings-dialog .b-section > [data-b="close"]');
await wait(p, 120);
check("S5 closing Settings with unsaved text asks", (await confirmText(p)).includes("Leave without saving?") && (await p.evaluate(() => document.querySelector("#settings-dialog").open)));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 120);
check("S5 Leave closes it", !(await p.evaluate(() => document.querySelector("#settings-dialog").open)));
await p.close();

p = await open(LIB + "&skill=trail&banner=offline");
await typeInto(p, "#k-body", "Offline edit.");
check("S2 R4 offline: the edit stays, Save waits for the connection", (await dialog(p)).includes("Not connected to the gateway. What you type stays here; Save waits for the connection.") && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
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
await wait(p, 100);
check("S6 R4 pending: no outcome before the read", (await dialog(p)).includes("Saving…") && !(await dialog(p)).includes("Saved revision"));
await wait(p);
check("S6 saved: the page becomes the skill's page, from a read by name", (await text(p, "#b-section-title")) === "trail-notes" && (await dialog(p)).includes("Saved revision") && (await dialog(p)).includes("It is included in defaults, so new tasks a person starts can begin with it."));
await p.close();
for (const [mode, words] of [
  ["lost", ["Couldn't tell whether your save reached the gateway. Reading your library again found a skill named trail-notes, revision", "whether your save made it isn't known.", "Open it"]],
  ["lostnot", ["Couldn't tell whether your save reached the gateway. Reading your library again found no skill named trail-notes. Your text is still here."]],
]) {
  p = await open(LIB + "&skill=new&save=" + mode);
  await typeInto(p, "#k-slug", "trail-notes");
  await typeInto(p, "#k-desc", "Use when writing up a walk.");
  await typeInto(p, "#k-body", "Note the distance.");
  await p.click('[data-k="save"]');
  await wait(p);
  t = await dialog(p);
  check(`S6 R4 new skill, ${mode}: only what the read by name found`, has(t, ...words) && !t.includes("Saved revision") && (await text(p, "#b-section-title")) === "New skill");
  await p.close();
}
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
check("S6 over the gateway's limit in bytes: said before sending", (await text(p, "#k-body-help")) === "Too long for the gateway: SKILL.md may be at most 1,048,576 bytes, frontmatter included. Letters outside English count as more than one byte." && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await p.close();

// Removing (section 7) and sharing (section 8) -------------------------------------------------------
p = await open(LIB + "&skill=trail");
await typeInto(p, "#k-body", "An edit that isn't saved.");
await p.click('[data-k="remove"]');
await wait(p, 120);
check("S7 R4 Remove asks, says what tasks keep, and names the unsaved edit it loses", has(await confirmText(p), "Remove trail-checklist?", "Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name.", "Your unsaved edit on this page is lost too."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 100);
check("S7 R4 pending: Removing…, and no Removed before the read", (await dialog(p)).includes("Removing…") && !(await dialog(p)).includes("Removed."));
await wait(p);
check("F-362 S7 removed: said from the read-back, the row gone", (await dialog(p)).includes("Removed. Reading your library again: trail-checklist isn't in it. Tasks that have it keep their revision.") && !(await p.$('[data-k-skill="trail"]')) && (await gwRead(p, "trail")).removed === true && (await announced(p)) === "Removed");
await p.close();
p = await open(LIB + "&skill=trail");
await p.click('[data-k="remove"]');
await wait(p, 120);
check("S7 with nothing unsaved, Remove doesn't mention an edit", !(await confirmText(p)).includes("unsaved"));
await p.close();
p = await open(LIB + "&skill=trail&remove=conflict");
await p.click('[data-k="remove"]');
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
check("S7 R4 a stale Remove: nothing removed, the page as read again", (await dialog(p)).includes("Someone else saved this skill since you opened it. Nothing was removed. This is what the gateway has now.") && (await gwRead(p, "trail")).rev !== undefined);
await p.close();

p = await open(LIB + "&skill=kitchen");
t = await dialog(p);
check("F-363 S8 R6 not shared: what sharing does, for eligible profiles, nothing claimed about others", has(t, "Share on this gateway", "Sharing makes it available to eligible profiles on this gateway: it is listed in their libraries, and their new tasks can begin with it while it is included in defaults. Nothing leaves the gateway.") && !t.includes("No one else has a profile"));
await p.click('[data-k="share"]');
await wait(p, 100);
check("S8 R4 pending: Sharing…, nothing shared yet on the page", (await dialog(p)).includes("Sharing…") && !(await dialog(p)).includes("Shared. Reading"));
await wait(p);
const kitchenRev = (await gwRead(p, "kitchen")).rev.slice(0, 12);
check(
  "F-363 S8 R6 shared: exactly what the read found, and no claim of who saw it",
  (await text(p, ".k-status")) === `Shared. Reading again: the gateway lists revision ${kitchenRev} among this gateway's shared skills.` && !/\b(saw|seen|viewed|opened it)\b/i.test(await dialog(p)) && (await announced(p)) === "Shared on this gateway",
);
check("F-363 S8 Stop sharing is offered, with what tasks keep", has(await dialog(p), "Stop sharing", "Tasks that have it keep it when you stop sharing."));
await p.click('[data-k="to-list"]');
await wait(p, 120);
check("F-363 S3 the row carries Shared", (await text(p, '[data-k-skill="kitchen"]')).includes("Shared"));
await p.click('[data-k-skill="kitchen"]');
await p.click('[data-k="share"]');
await wait(p);
check("F-363 S8 Stop sharing, from the read", (await text(p, ".k-status")) === "Not shared. Reading again: the gateway no longer lists it among this gateway's shared skills. Tasks that already have it keep their revision.");
await p.close();
p = await open(LIB + "&skill=kitchen");
await typeInto(p, "#k-desc", "Unsaved.");
check("S8 R4 with unsaved text, the saved revision a share acts on is named", await p.evaluate(() => { const l = document.querySelector("#k-share-saved"); return Boolean(l) && !l.hidden && l.textContent.includes("Sharing acts on the saved revision") && l.textContent.includes("not your unsaved edit."); }));
await p.close();
p = await open(LIB + "&skill=kitchen&share=raced");
await p.click('[data-k="share"]');
await wait(p);
check("S8 R6 opposite writes both accepted: the page says what the read shows", (await dialog(p)).includes("The gateway accepted sharing, but reading again shows it not shared: another change landed after yours."));
await p.close();

// Skills in a task (section 9) -----------------------------------------------------------------------
p = await open(TASK);
t = await details(p);
check("S9 R5 the task's skills, each with the task's own revision", await p.evaluate(() => [...document.querySelectorAll(".k-pin")].every((li) => li.querySelector(".k-rev").textContent === window.skills.pins.j1.find((x) => x.skillId === li.querySelector("[data-k-pin]").dataset.kPin).rev.slice(0, 12))));
check("S9 R5 the read's time, and what these are", t.includes("As read at 5:41 PM. The skills this task has saved for its next turns, each at its revision."));
check("S9 R2 needs not met is the only availability shown, for this task", has(t, "Needs not met", "The gateway says what it needs isn't there, for this task.") && !t.includes("Not given"));
check("S9 R2 the bot's filter is shown apart from the pins", t.includes("Juniper's skill filter is the gateway's default, no filter. A filter can leave out a skill this task has; it is set in Juniper's settings, apart from these."));
check("S9 nothing different: no Update", !(await p.$('[data-k="refresh"]')));
await p.click('[data-k-pin="kitchen"]');
await wait(p, 120);
check("S9 a held revision opens read-only, named as the task's", has(await details(p), "the one this task has", "A skill is instructions a bot follows.") && !(await p.$(".k-held textarea")));
await p.click('[data-k="held-back"]');
await wait(p, 120);
check("S9 R8 Back returns focus to the row that opened it", (await p.evaluate(() => document.activeElement?.dataset.kPin)) === "kitchen");
await p.click('[data-k="attach-open"]');
await wait(p, 100);
check("S9 Attach lists only skills the task doesn't have", has(await details(p), "pack-list", "ridge-safety") && !(await p.$('.k-attach-item[data-value="trail"]')));
await p.click('.k-attach-item[data-value="ridge"]');
await wait(p, 100);
check("S9 R4 pending: Attaching…, no outcome yet", (await details(p)).includes("Attaching…") && !(await details(p)).includes("Attached:"));
await wait(p);
check("S9 attached: from the read, from the next turn", has(await details(p), "Attached: reading the task again, it has that skill. From this task's next turn.") && Boolean(await p.$('[data-k-pin="ridge"]')));
await p.click('[data-k="detach"][data-value="kitchen"]');
await wait(p);
check("S9 detached: from the read", has(await details(p), "Detached: reading the task again, it no longer has that skill.") && !(await p.$('[data-k-pin="kitchen"]')));
await p.close();

p = await open(TASK);
await p.click('[data-k="attach-open"]');
await p.click('.k-attach-item[data-value="ridge"]');
await p.click('[data-testid="bot-list"] [data-task="j3"], .task-row[data-task="j3"]').catch(() => p.evaluate(() => window.app.openTask("j3")));
await wait(p);
check("S9 R5 a task write keeps its own task when another is opened meanwhile", await p.evaluate(() => window.skills.pins.j1.some((x) => x.skillId === "ridge") && !window.skills.pins.j3));
await p.close();

p = await open(TASK + "&pins=outdated&running=1");
t = await details(p);
const stored = await p.evaluate(() => window.skills.pins.j1.find((x) => x.skillId === "trail"));
const library = await gwRead(p, "trail");
check("S9 R5 a different library revision: tagged as different, the library's named, the task's shown", has(t, "Different library revision", `The library has revision ${library.rev.slice(0, 12)}.`, "Update to the library's current revisions", "Updates every skill in this task.") && (await text(p, '[data-k-pin="trail"] .k-rev')) === stored.rev.slice(0, 12) && stored.rev !== library.rev && !t.includes("Newer revision"));
await p.click('[data-k-pin="trail"]');
await wait(p, 120);
check("S9 R5 the held revision shows the task's own text, not the library's", (await p.evaluate(() => document.querySelector("[data-k-held]").textContent)) === stored.body && stored.body !== library.body);
await p.click('[data-k="held-back"]');
await p.click('[data-k="refresh"]');
await wait(p);
t = await details(p);
check("F-361 S9 updated, from the read: from the next turn; the running turn keeps its own", has(t, "Updated: reading the task again, its skills are at the library's current revisions. From this task's next turn. The turn running now keeps the skills it started with.") && !t.includes("Different library revision"));
await p.close();

p = await open(TASK + "&pins=removed");
t = await details(p);
check("S9 R5 a removed skill: told by the gateway's read, blocks Update", has(t, "Removed from the library", "Detach the skills marked unavailable or removed first: the gateway refuses to update a task that has one.") && (await p.evaluate(() => document.querySelector('[data-k="refresh"]').disabled)));
await p.click('[data-k="detach"][data-value="gone"]');
await wait(p, 120);
check("S9 detaching a removed skill says it can't come back", (await confirmText(p)).includes("It was removed from your library, so it can't be attached again."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
check("S9 then Update is offered", !(await p.evaluate(() => document.querySelector('[data-k="refresh"]').disabled)));
await p.close();
p = await open(TASK + "&pins=unavailable&access=write");
t = await details(p);
check("S9 R5 an entry this connection can't read is unavailable, not removed", t.includes("Library entry unavailable") && !t.includes("Removed from the library"));
await p.click('[data-k="detach"][data-value="elsewhere"]');
await wait(p, 120);
check("S9 R5 detaching it says it may not come back", (await confirmText(p)).includes("Its library entry isn't available to this connection, so it may not be attachable again."));
await p.close();
for (const [mode, words] of [
  ["refused", "The gateway answered: Session changed before activation; refresh and retry. Nothing changed; the skills above are as read again."],
  ["lost", "Couldn't tell whether the change reached the gateway. The skills above are as read again."],
]) {
  p = await open(TASK + "&taskw=" + mode);
  await p.click('[data-k="detach"][data-value="kitchen"]');
  await wait(p);
  check(`S9 R4 a task write ${mode}: its words, from the read`, (await details(p)).includes(words));
  await p.close();
}
for (const [state, words] of [
  ["none", "This task has no skills from your library."],
  ["error", "Couldn't load this task's skills. The gateway answered: Session not found."],
]) {
  p = await open(TASK + "&pins=" + state);
  check(`S9 ${state}: its words`, (await details(p)).includes(words));
  await p.close();
}
p = await open("bot=pip&task=p1&panel=open&tab=details");
check("S9 R8 another bot's task shows its own skills", has(await details(p), "ridge-safety", "kitchen-timer", "Pip's skill filter is the gateway's default, no filter."));
await p.close();
p = await open(TASK + "&list=only");
check("S9 R2 the bot's own filter is named as its own", (await details(p)).includes("Juniper's skill filter is its own filter, only 2."));
await p.close();
p = await open(TASK + "&access=read");
t = await details(p);
check("S9 read-only: the skills, no Detach or Attach", t.includes("Changing a task's skills needs write access.") && !(await p.$('.k-task [data-k="detach"]')) && !(await p.$('[data-k="attach-open"]')));
await p.close();
p = await open(TASK + "&banner=offline");
check("S9 R4 offline: task writes disabled", await p.evaluate(() => [...document.querySelectorAll('.k-task [data-k="detach"], [data-k="attach-open"]')].every((x) => x.disabled)));
await p.close();

// A bot's skill filter (section 10) --------------------------------------------------------------------
p = await open("bot=juniper&panel=open&tab=settings");
check("S10 R2 the Tools group has a Skill filter row with how it is set", (await text(p, '#panel-settings [data-bs="skills"]')).includes("Skill filterGateway default"));
await p.click('#panel-settings [data-bs="skills"]');
await wait(p, 150);
t = await tab(p);
check("S10 R2 a filter narrows and never adds; the gateway's default chosen, and what it is", has(t, "A filter narrows the skills Juniper can be given in a task. It doesn't add any", "Use the gateway's default", "The gateway sets no default, so a bot without its own filter has none: nothing narrows its skills.") && (await p.evaluate(() => document.querySelector('[data-k-choice="default"]').getAttribute("aria-checked"))) === "true" && !t.includes("Every skill"));
check("S10 R2 learned skills bypass the filter, other gates still apply; a task's overrides aren't shown", t.includes("Skills Juniper learned bypass this filter; the gateway can still leave one out when what it needs isn't there or it is switched off in the gateway's settings. A task can also carry skill overrides of its own on the gateway, which Clawtrate doesn't show."));
await p.focus('[data-k-choice="default"]');
await p.keyboard.press("ArrowDown");
await wait(p, 150);
check("S13 R8 an arrow moves the choice and keeps focus on it", (await p.evaluate(() => document.activeElement?.dataset.kChoice)) === "only" && (await p.evaluate(() => document.querySelector('[data-k-choice="only"]').getAttribute("aria-checked"))) === "true");
await p.click('[data-k-choice="none"]');
await p.click('[data-k="list-save"]');
await wait(p, 100);
check("S10 R4 pending: Saving…, no Saved yet", (await tab(p)).includes("Saving…") && !(await tab(p)).includes("Saved."));
await wait(p);
check("F-199 S10 saved: the filter as read again, from each task's next turn", (await tab(p)).includes("Saved. Reading again, the filter is none. It applies from each task's next turn; a turn running now keeps the skills it started with."));
await p.click('#panel-settings [data-bs="main"]');
await wait(p, 150);
check("S10 the row reads None after the read-back", (await text(p, '#panel-settings [data-bs="skills"]')).includes("None"));
await p.close();

p = await open(BOT + "&defaults=none");
check("S10 R2 an inherited empty default is named, so Gateway default never reads as every skill", (await tab(p)).includes("The gateway's default is none: a bot without its own filter is given no skills from a library or the gateway."));
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
check("S10 R2 a name the gateway doesn't list now: apart, and what it still matches", has(t, "Not in the gateway's lists now", "s_old_route_9b1c2d3e4f5a6b7c8d9e", "It matches no skill the gateway lists now. A task can still have a skill by this name, and the filter lets that one through."));
await p.click('[data-k="list-drop"]');
await wait(p, 120);
check("S10 Remove from the filter", !(await tab(p)).includes("s_old_route_9b1c2d3e4f5a6b7c8d9e"));
await p.close();
for (const [mode, words] of [
  ["conflict", "Someone else changed Juniper's settings. Nothing was written. This shows what the gateway has now: none."],
  ["refused", "The gateway answered: invalid config: agents.entries.main.skills must be an array of strings Nothing was written; reading again, the filter is gateway default."],
  ["lost", "Couldn't tell whether it was saved. Reading again, the filter is none."],
]) {
  p = await open(BOT + "&cfg=" + mode);
  await p.click('[data-k-choice="none"]');
  await p.click('[data-k="list-save"]');
  await wait(p);
  check(`S10 R4 the filter's write ${mode}: what the read shows`, (await tab(p)).includes(words), (await tab(p)).slice(0, 300));
  await p.close();
}
p = await open(BOT + "&access=write");
t = await tab(p);
check("S10 below admin: the value, no Save, the access bar", t.includes("Admin access needed. Changing Juniper's skill filter changes the gateway's settings.") && !(await p.$('[data-k="list-save"]')) && (await p.evaluate(() => document.querySelector('[data-k-choice="default"]').getAttribute("aria-disabled"))) === "true");
await p.close();

// What a bot learned (section 10.2)
p = await open(BOT);
t = await tab(p);
check("S10.2 R7 learned: each change by the actor the gateway records, the review included", has(t, "What Juniper learned", "Saved by Juniper in Weekend walk checklist, 3:04 PM", "Saved by the gateway's review, 2:10 PM", "Learning on its ownOn", "Its documentation says"));
await p.click('[data-k-learned="trail-checklist"]');
await wait(p, 150);
t = await tab(p);
check("S10.2 a learned skill opens read-only, with its changes", has(t, "Its text, as the gateway keeps it", "There is no editor for a learned skill: only the bot's own tool changes it.", "SKILL.md") && !(await p.$("#panel-settings textarea")));
await p.click('[data-k="archive"]');
await wait(p, 120);
check("S10.2 Archive asks, and says it can be restored", has(await confirmText(p), "Archive trail-checklist?", "Juniper stops being given it. The gateway keeps it, and you can restore it."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 100);
check("S10.2 R4 pending: Archiving…, no outcome yet", (await tab(p)).includes("Archiving…") && !(await tab(p)).includes("Archived. Reading"));
await wait(p);
t = await tab(p);
check("F-362 S10.2 archived: from the read, by a person", t.includes("Archived. Reading again, trail-checklist is in Archived.") && (await announced(p)) === "Archived");
await p.click('[data-k="restore"]');
await wait(p);
check("S10.2 Restore, from the read", (await tab(p)).includes("Restored. Reading again, trail-checklist is live for Juniper.") && (await tab(p)).includes("Restored by a person"));
await p.close();
p = await open(BOT + "&learned=empty");
check("S10.2 nothing learned: its words", (await tab(p)).includes("Nothing learned yet"));
await p.close();
p = await open("bot=juniper&panel=open&tab=settings&bview=learned&access=write");
check("S10.2 below admin: no Archive, the access bar", !(await p.$('[data-k="archive"]')) && (await tab(p)).includes("Archiving a skill Juniper learned needs admin access."));
await p.close();

// The cards (section 12) ------------------------------------------------------------------------------
p = await open("bot=juniper&task=jlearn");
const cards = await p.evaluate(() => [...document.querySelectorAll(".k-card > summary")].map((s) => s.getAttribute("aria-label")));
check(
  "F-198 S12 R7 every card from its call and result, in the family's words",
  cards.join("|") === "Saved a skill trail-checklist, Saved to your library|Looked at skills 1 in the library, Done|Shared a skill trail-checklist, Shared on this gateway|Couldn't save a skill trail-checklist, Failed|Learned a skill trail-checklist, Learned",
  cards.join("|"),
);
check("S12 R7 every card has Raw: the call's arguments and the gateway's result", await p.evaluate(() => [...document.querySelectorAll(".k-card")].every((c) => { const r = c.querySelector(":scope > .action-body > .k-raw"); return r && r.textContent.includes("Arguments") && /Result|Error/.test(r.textContent); })));
check("S12 R7 the destination comes from the result's target", await p.evaluate(() => window.CT.skillsCardOf({ args: { action: "create", name: "x", proposal_content: "---\nname: x\ndescription: d\n---\n\nb\n" }, result: JSON.stringify({ state: "published", target: "team", entry: { revision: "a".repeat(64) } }), isError: false }).state === "Saved to the team library"));
await p.click("#k-card-saved > summary");
await wait(p, 100);
check("S12 S2 the saved card's instructions are text: angle brackets kept, no element inside", await p.evaluate(() => { const pre = document.querySelector("#k-card-saved .k-card-facts pre"); return Boolean(pre) && pre.childElementCount === 0 && pre.textContent.includes("<important>"); }));
await p.click("#k-card-learned > summary");
await wait(p, 100);
check("S12 R7 the learned card shows its instructions", await p.evaluate(() => { const pre = document.querySelector("#k-card-learned .k-card-facts pre"); return Boolean(pre) && pre.textContent.includes("1. Check the forecast for the day of the walk.") && pre.childElementCount === 0; }));
check("S12 R7 the attach line is from this task's read: not held, attachable", (await text(p, "#k-card-attach")).includes("This task doesn't have it: a skill saved during a task isn't added to that task.") && Boolean(await p.$('[data-k="card-attach"]')));
await p.click('[data-k="card-attach"]');
await wait(p, 100);
check("S12 R4 Use in this task: pending, no outcome yet", (await text(p, "#k-card-attach")) === "Attaching…");
await wait(p);
const held = await p.evaluate(() => window.skills.pins.jlearn.find((x) => x.skillId === "trail")?.rev.slice(0, 12));
check("S12 attached: from the read, the task's revision named", Boolean(held) && (await text(p, "#k-card-attach")) === `Attached: reading the task again, it has revision ${held} from its next turn.`);
await p.click("#k-card-refused > summary");
await wait(p, 100);
check("S12 a refused call shows the gateway's text as text", (await text(p, "#k-card-refused")).includes('Validation failed for tool "skill_workshop"'));
await p.click('[data-k="card-open"]');
await wait(p, 200);
check("S12 Open in Skills opens the skill's page", (await p.evaluate(() => document.querySelector("#settings-dialog").open)) && (await text(p, "#b-section-title")) === "trail-checklist");
await p.close();
p = await open("bot=juniper&task=jlearn&access=read");
check("S12 R7 read-only: no attach offered, and why", (await text(p, "#k-card-attach")) === "This task doesn't have it. Attaching it needs write access." && !(await p.$('[data-k="card-attach"]')));
await p.close();
p = await open("bot=juniper&task=jlearn&cardw=refused");
await p.click('[data-k="card-attach"]');
await wait(p);
check("S12 R4 a refused attach: the gateway's words and the read", (await text(p, "#k-card-attach")).includes("The gateway answered: Session changed before activation; refresh and retry. Reading the task again, it doesn't have it."));
await p.close();
p = await open("bot=juniper&task=jlearn");
await p.click("#k-card-learned > summary");
await p.click('[data-k="card-learned"]');
await wait(p, 250);
check("S12 Open in Juniper's skills opens the learned skill", (await tab(p)).includes("Its text, as the gateway keeps it"));
await p.close();

// Widths and themes (section 13) ---------------------------------------------------------------------
for (const [width, viewport] of [
  ["full", { width: 1440, height: 900 }],
  ["1100", { width: 1440, height: 900 }],
  ["800", { width: 1440, height: 900 }],
  ["phone", { width: 390, height: 844 }],
]) {
  p = await open(LIB + "&skill=trail&save=conflict&width=" + width, viewport);
  await typeInto(p, "#k-body", "An edit at " + width + ".");
  await p.click('[data-k="save"]');
  await wait(p);
  check(`S13 R8 ${width}: the comparison is one column, the gateway's first, nothing sideways`, (await oneColumn(p)) && (await fits(p, ".b-section-body")));
  await p.close();
  p = await open("bot=juniper&task=jlearn&width=" + width, viewport);
  await p.click("#k-card-saved > summary");
  await wait(p, 400);
  check(`S13 R8 ${width}: the card's values wrap, none cut off`, await fits(p, "#k-card-saved .k-card-facts dd"));
  await p.close();
  p = await open(LIB + "&skill=kitchen&width=" + width, viewport);
  check(`S13 R8 ${width}: a file's facts wrap`, await fits(p, ".k-files dd"));
  await p.close();
  p = await open(LIB + "&skill=long&longname=1&access=read&width=" + width, viewport);
  check(`S13 R8 ${width}: a 63-character name and a read-only Use when… wrap`, (await fits(p, ".b-section-head h3")) && (await fits(p, "#k-desc-text")) && (await p.evaluate(() => document.querySelector(".b-section-head h3").getBoundingClientRect().right <= document.querySelector(".b-section > .b-close").getBoundingClientRect().left + 1)));
  await p.close();
  p = await open(TASK + "&pins=outdated&width=" + width, viewport);
  check(`S13 ${width}: the task's skills fit the pane`, (await details(p)).includes("Different library revision") && (await fits(p, ".k-task")));
  await p.close();
}
p = await open(LIB + "&width=phone", { width: 390, height: 844 });
check("S13 phone: rows are 64 px", await p.evaluate(() => Math.round(document.querySelector(".k-row").getBoundingClientRect().height) >= 64));
await p.close();
p = await open(TASK + "&theme=dark&pins=outdated");
check("S13 dark: the task's skills render", (await details(p)).includes("Different library revision"));
await p.close();

check("S2 the pages made no request to any host", outbound.length === 0, outbound.slice(0, 3).join(" "));

await b.close();
console.log(out.join("\n"));
console.log(`${out.filter((l) => l.startsWith("ok")).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
