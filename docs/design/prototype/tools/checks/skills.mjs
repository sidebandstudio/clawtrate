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
  await p.waitForFunction(() => Boolean(window.skills) && document.readyState === "complete", null, { timeout: 20000 });
  await p.waitForTimeout(400);
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ").trim() || "", sel);
const dialog = (p) => text(p, "#settings-dialog");
const details = (p) => text(p, ".k-task");
const tab = (p) => text(p, "#panel-settings");
const has = (t, ...words) => words.every((w) => t.includes(w));
// A settle waits its time, then until no write of the page is still waiting for its answer or
// its read, so a slow machine doesn't read a pending state as an outcome.
const wait = async (p, ms = SETTLE) => {
  await p.waitForTimeout(ms);
  if (ms === SETTLE) await p.waitForFunction(() => !window.skills.busy(), null, { timeout: 20000 }).catch(() => {});
};
const announced = async (p) => {
  await p.waitForTimeout(80);
  await p.waitForFunction(() => document.querySelector("#b-announce").textContent, null, { timeout: 3000 }).catch(() => {});
  return p.evaluate(() => document.querySelector("#b-announce").textContent);
};
// Cases that type while a write waits give the write a slower answer, so a slow machine still types in time.
const SLOW = "&answer=2000";
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
let g;
check("S3 Skills sits after Accounts in Settings", await p.evaluate(() => [...document.querySelectorAll(".b-nav-item")].map((n) => n.textContent.trim()).join(",") === "Gateway,Accounts,Skills,Integrations"));
check("S3 R6 the lead claims nothing about a person's other devices", t.includes("Skills in your library on this gateway, and skills others share here. A library skill reaches a bot only in a task that has it.") && !t.includes("Every device"));
check("S3 R6 an admin sees others' skills, unshared ones marked", (await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-group")].map((g) => g.textContent).join(","))) === "Your skills,Others' skills on this gateway" && (await text(p, '[data-k-skill="elsewhere"]')).includes("From Robin Park, not shared"));
check("S3 R3 a skill left out of defaults says so", (await text(p, '[data-k-skill="pack"]')).includes("Not in defaults"));
check("S3 a team skill carries the word Team", (await text(p, '[data-k-skill="ridge"]')).includes("Team"));
check("S3 R3 which new tasks get defaults, exactly, and that a save leaves existing pins", t.includes("When an attributed person with a gateway profile creates a task, the gateway can pin up to 64 enabled library skills, their own first. Spawned tasks and tasks the gateway marks synthetic do not get these defaults. A save does not change an existing task's pins.") && !t.includes("A task a person starts begins"));
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
check(
  "S3 R6 no profile (admin): a team skill (owner null) is not Your skills, though both are null",
  (await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .b-group")].map((g) => g.textContent).join(","))) === "Others' skills on this gateway" && (await p.evaluate(() => window.skills.G.profile === null && window.skills.G.skills.find((s) => s.id === "ridge").owner === null)),
);
await p.click('[data-k-skill="ridge"]');
await wait(p, 150);
t = await dialog(p);
check("S4 R6 no profile, admin: the team skill's owner is Team, no edit field, its defaults flag as read with no switch", has(t, "OwnerTeam", "Include in defaults for new tasksIncluded") && !t.includes("OwnerYou") && !(await p.$("#k-body")) && !(await p.$('[data-k="enable"]')) && !(await p.$('[data-k="save"]')));
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
check("S2 the page says what a skill is, and calls nothing safe", t.includes("A skill supplies instructions to a bot. A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it.") && !/\b(safe|verified|trusted)\b/i.test(t));
check("S4 the name is fixed in Clawtrate, and says so", t.includes("A skill's name is set when it is made in Clawtrate.") && !(await p.$("#k-slug")));
check("S4 R6 the facts: owner You, a revision, Not shared", has(t, "OwnerYou", "SharedNot shared") && !t.includes("Only you") && (await p.evaluate(() => /^[0-9a-f]{12}$/.test(document.querySelector(".k-rev").textContent))));
check("S2 angle brackets in instructions stay text", (await p.evaluate(() => document.querySelector("#k-body").value)).includes("<important>"));
check("S4 Save starts disabled", await p.evaluate(() => document.querySelector('[data-k="save"]').disabled));
await p.click('[data-k="enable"]');
await wait(p, 150);
check("S4.1 R4 the switch waits for the read: pending, not moved, nothing announced", (await dialog(p)).includes("Saving…") && (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === "true");
await wait(p);
check("S4.1 R3 then moves to the read's value, with its line", (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === "false" && (await dialog(p)).includes("Excluded from defaults. It can still be attached where the gateway offers it.") && (await gwRead(p, "trail")).enabled === false);
check("S4.1 R4 the switch sent the saved revision it showed", (await p.evaluate(() => window.skills.sent.at(-1))).expectedRevision === (await gwRead(p, "trail")).rev);
await p.click('[data-k="to-list"]');
await wait(p, 150);
check("S4 Back returns focus to the skill's row, now Not in defaults", (await p.evaluate(() => document.activeElement?.dataset.kSkill)) === "trail" && (await text(p, '[data-k-skill="trail"]')).includes("Not in defaults"));
await p.close();

// The switch after another device saved the skill: the request carries the old revision and is refused.
p = await open(LIB + "&skill=trail");
await p.evaluate(() => window.skills.otherSave("trail"));
await p.click('[data-k="enable"]');
await wait(p, 450);
check("S4.1 R4 a stale switch: after the receipt and before the read, still pending, nothing said", (await dialog(p)).includes("Saving…") && !(await dialog(p)).includes("refused") && (await gwRead(p, "trail")).enabled === true);
await wait(p);
g = await gwRead(p, "trail");
check(
  "S4.1 R4 a stale switch: the flag untouched on the gateway, the refusal and the read's revision, no success",
  g.enabled === true && (await dialog(p)).includes(`The gateway refused this request because it read a different revision. Reading it again found revision ${g.rev.slice(0, 12)}, included in defaults.`) && (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === "true" && (await announced(p)) === "Not changed",
);
await p.close();
for (const [mode, words] of [
  ["raced", "The gateway accepted the request. The skill is included in defaults as of the next read."],
  ["lost", "The gateway did not answer this request. Reading the skill again, it is not included in defaults."],
  ["readfail", "Couldn't read the skill again. The setting shown is from the earlier read."],
]) {
  p = await open(LIB + "&skill=trail&enable=" + mode);
  await p.click('[data-k="enable"]');
  await wait(p);
  check(`S4.1 R4 the switch, ${mode}: the receipt and the read apart, no plain success`, (await dialog(p)).includes(words) && (await p.evaluate(() => document.querySelector('[data-k="enable"]').getAttribute("aria-checked"))) === (mode === "lost" ? "false" : "true"), (await dialog(p)).slice(0, 300));
  await p.close();
}

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
g = await gwRead(p, "weather");
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
check("S4.1 R6 a team skill below admin: the defaults flag as read, no switch, since the read's canEdit is false", (await dialog(p)).includes("Include in defaults for new tasksIncluded") && !(await p.$('[data-k="enable"]')) && (await p.evaluate(() => window.skills.read("ridge").canEdit)) === false);
await p.close();
p = await open(LIB + "&skill=trail&access=read");
check("S4.1 R6 read-only on the person's own skill: the read's canEdit is false, the defaults flag as read, no switch", (await dialog(p)).includes("Include in defaults for new tasksIncluded") && !(await p.$('[data-k="enable"]')) && (await p.evaluate(() => window.skills.read("trail").canEdit)) === false);
await p.close();
p = await open(LIB + "&skill=elsewhere");
check("S4.1 R6 an admin on another person's entry: the read's canEdit and write scope give the switch; no Share there", Boolean(await p.$('[data-k="enable"]')) && (await p.evaluate(() => window.skills.read("elsewhere").canEdit)) === true && !(await p.$('[data-k="share"]')));
await p.close();

// Saving (section 5) ---------------------------------------------------------------------------------
p = await open(LIB + "&skill=trail" + SLOW);
await typeInto(p, "#k-body", "1. Check the forecast.\n2. Pack water and a map.");
check("S5 an edit enables Save", !(await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await p.click('[data-k="save"]');
await wait(p, 100);
t = await dialog(p);
check("S5 R4 pending: Saving…, and no outcome before the read", t.includes("Saving…") && !t.includes("Saved revision") && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await typeInto(p, "#k-body", "1. Check the forecast.\n2. Pack water and a map.\n3. Typed while it saved.");
await p.focus("#k-desc");
await p.keyboard.press("Escape");
await p.click('[data-k="to-list"]');
check("S2 R8 a pending Save: Escape and Back wait, the page stays open on its subject", (await p.evaluate(() => document.querySelector("#settings-dialog").open)) && (await text(p, "#b-section-title")) === "trail-checklist" && !(await confirmText(p)).includes("Leave without saving?") && (await p.evaluate(() => window.skills.K.page)) === "trail");
await wait(p);
t = await dialog(p);
g = await gwRead(p, "trail");
check("S5 R4 what was sent is what was there at the click; later typing is kept", g.body === "1. Check the forecast.\n2. Pack water and a map." && (await p.evaluate(() => document.querySelector("#k-body").value)).endsWith("Typed while it saved.") && t.includes("You typed more after you chose Save. That text is still here, unsaved."));
check("F-361 S5 R3 Saved names the revision the read shows, and says only that tasks keep their pins", t.includes(`Saved revision ${g.rev.slice(0, 12)}. Tasks that hold it keep their pins.`) && !t.includes("New tasks that begin") && !t.includes("New tasks start with revision") && (await announced(p)) === "Saved");
await p.close();

p = await open(LIB + "&skill=pack");
await typeInto(p, "#k-body", "Pack lighter.");
await p.click('[data-k="save"]');
await wait(p);
t = await dialog(p);
check("S5 R3 a skill left out of defaults: the save says the same, and the switch carries the condition", t.includes("Tasks that hold it keep their pins.") && !t.includes("new tasks don't begin with it") && t.includes("Excluded from defaults. It can still be attached where the gateway offers it."));
await p.close();

for (const [mode, words, ann] of [
  ["unchanged", ["The gateway already had this bundle at revision"], "Already saved"],
  ["refused", ["The gateway answered: Skill library authority changed. Refresh and retry. The next read found revision", "Your text is still here."], "Couldn't save"],
  ["silent", ["The gateway answered that it couldn't complete the save, without saying why. The next read found revision", "Your text is still here."], "Couldn't save"],
  ["superseded", ["The gateway returned revision", "for your save. The next read found revision", "The page shows"], "The next read found a different revision"],
  ["readfail", ["The gateway returned revision", "for your request. Reading the skill again failed. The page still shows the previous read.", "Read again"], "Couldn't read the skill again."],
]) {
  p = await open(LIB + "&skill=trail&save=" + mode);
  if (mode === "unchanged") {
    await typeInto(p, "#k-body", "x");
    await typeInto(p, "#k-body", (await gwRead(p, "trail")).body);
    await p.evaluate(() => (document.querySelector('[data-k="save"]').disabled = false));
  } else await typeInto(p, "#k-desc", "Use when planning a walk.");
  await p.click('[data-k="save"]');
  await wait(p);
  t = await dialog(p);
  check(`S5 R4 ${mode}: its words, from the receipt and the read`, has(t, ...words) && !/key or a password|saved after it|Saved revision|unchanged\./.test(t) && (await announced(p)) === ann, t.slice(0, 400));
  await p.close();
}

// A rollback after the save: the read shows an earlier revision, and the page doesn't call it later.
p = await open(LIB + "&skill=trail&save=rollback");
await typeInto(p, "#k-desc", "Use when planning a walk.");
await p.click('[data-k="save"]');
await wait(p);
const [first, mine2] = await p.evaluate(() => window.skills.G.skills.find((s) => s.id === "trail").history.map((h) => h.rev).filter((r, i, a) => i === 0 || i === a.length - 1));
check(
  "S5 R4 rollback: the receipt's revision and the read's, exactly, with no claim of which came later",
  (await text(p, "#settings-dialog [role=status]")) === `The gateway returned revision ${mine2.slice(0, 12)} for your save. The next read found revision ${first.slice(0, 12)}. The page shows ${first.slice(0, 12)}.` && (await gwRead(p, "trail")).rev === first && (await announced(p)) === "The next read found a different revision",
);
await p.close();
// A refusal, then another device's save before the read: the read's revision, the draft kept, compared.
p = await open(LIB + "&skill=trail&save=refusedmoved");
await typeInto(p, "#k-body", "Keep it after refusal.");
await p.click('[data-k="save"]');
await wait(p);
g = await gwRead(p, "trail");
check(
  "S5 R4 refused, then a different revision: the read's revision named, nothing called unchanged, the draft kept and compared",
  (await dialog(p)).includes(`The gateway answered: Skill library authority changed. Refresh and retry. The next read found revision ${g.rev.slice(0, 12)}. Your text is still here.`) &&
    (await p.evaluate(() => document.querySelector("#k-body").value)) === "Keep it after refusal." &&
    (await p.evaluate(() => document.querySelector("[data-k-theirs]")?.textContent)) === g.body &&
    (await announced(p)) === "Couldn't save",
);
await p.close();
p = await open(LIB + "&skill=trail&save=refusedreadfail");
await typeInto(p, "#k-body", "Keep it after a failed read.");
await p.click('[data-k="save"]');
await wait(p);
check(
  "S5 R4 refused, and the read fails: the refusal, the failed read, the draft kept",
  (await dialog(p)).includes("The gateway answered: Skill library authority changed. Refresh and retry. Couldn't read the skill again. The page shows the last readable revision. Your text is still here.") && (await p.evaluate(() => document.querySelector("#k-body").value)) === "Keep it after a failed read." && (await announced(p)) === "Couldn't read the skill again.",
);
await p.close();

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
check("S5 removed meanwhile: told by the read's tombstone, the text is still here", (await dialog(p)).includes("This skill was removed on the gateway. Your text is still here.") && (await gwRead(p, "trail")).removed === true && (await announced(p)) === "Couldn't save");
await p.click('[data-k="save-as-new"]');
await wait(p, 150);
t = await dialog(p);
check("S6 R1 Save text as a new skill: named as such, says what isn't copied", (await text(p, "#b-section-title")) === "Save text as a new skill" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "My own steps." && t.includes("The removed skill's other settings and files aren't copied: the new skill has only this Use when… and these instructions."));
await p.close();
// Not found, and the read refuses the entry: not called removed.
p = await open(LIB + "&skill=trail&save=hidden&access=write");
await typeInto(p, "#k-body", "My steps for a hidden skill.");
await p.click('[data-k="save"]');
await wait(p);
t = await dialog(p);
check(
  "S5 R4 not found and unreadable, not tombstoned: not called removed, the text kept, Save text as a new skill offered",
  t.includes("Couldn't read this skill again. Your text is still here.") && !t.includes("was removed") && Boolean(await p.$('[data-k="save-as-new"]')) && (await p.evaluate(() => document.querySelector("#k-body").value)) === "My steps for a hidden skill." && (await announced(p)) === "Couldn't read the skill again.",
);
await p.close();

// The gateway has a different revision (section 5.1)
p = await open(LIB + "&skill=trail&save=conflict");
await typeInto(p, "#k-body", "My edit of the checklist.");
await p.click('[data-k="save"]');
await wait(p);
t = await dialog(p);
g = await gwRead(p, "trail");
check("S5.1 a different revision: the note names the revision and when it was read, and no person", has(t, `The gateway has a different revision: ${g.rev.slice(0, 12)}, as read at`, "Your edit isn't saved. Compare them, then choose.", "On the gateway now", "Your edit", "Theirs stays as an earlier revision on the gateway.") && !t.includes("Someone else") && (await announced(p)) === "The gateway has a different revision");
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
p = await open(LIB + SLOW);
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
check("S6 R4 the new Name is read-only until the creation settles", await p.evaluate(() => document.querySelector("#k-slug").readOnly));
await typeInto(p, "#k-body", "Note the distance, the time and the weather.");
await wait(p);
t = await dialog(p);
check(
  "S6 R1 what was sent is stored; what was typed during the save stays in the field, unsaved",
  (await gwRead(p, "new-trail-notes")).body === "Note the distance and the time." && (await p.evaluate(() => document.querySelector("#k-body").value)) === "Note the distance, the time and the weather." && t.includes("You typed more after you chose Save. That text is still here, unsaved."),
);
check("S6 saved: the page becomes the skill's page, from a read by name", (await text(p, "#b-section-title")) === "trail-notes" && (await dialog(p)).includes("Saved revision") && (await dialog(p)).includes("Tasks that hold it keep their pins.") && !(await dialog(p)).includes("new tasks a person starts can begin with it") && (await dialog(p)).includes("Eligible new tasks can start with this skill, subject to the 64-skill limit."));
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
  check(`S6 R4 new skill, ${mode}: only what the read by name found`, has(t, ...words) && !t.includes("Saved revision") && (await text(p, "#b-section-title")) === "New skill" && (await announced(p)) === "Couldn't tell whether it was saved");
  await p.close();
}
for (const [mode, words, ann, created] of [
  ["refused", "The gateway answered: Skill library authority changed. Refresh and retry. Your text is still here.", "Couldn't save", false],
  ["readfail", "for your request. Reading the skill again failed. Your text is still here.", "Couldn't read the skill again.", true],
  ["lostother", "Couldn't tell whether your save reached the gateway. Reading your library again found a skill named trail-notes, revision", "Couldn't tell whether it was saved", false],
]) {
  p = await open(LIB + "&skill=new&save=" + mode);
  await typeInto(p, "#k-slug", "trail-notes");
  await typeInto(p, "#k-desc", "Use when writing up a walk.");
  await typeInto(p, "#k-body", "Note the distance.");
  await p.click('[data-k="save"]');
  await wait(p);
  t = await dialog(p);
  check(
    `S6 R4 new skill, ${mode}: no success, the form kept, ${created ? "the receipt's revision named" : "nothing created by this request"}`,
    t.includes(words) && !t.includes("Saved revision") && (await text(p, "#b-section-title")) === "New skill" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "Note the distance." && Boolean((await gwRead(p, "new-trail-notes")).rev) === created && (await announced(p)) === ann,
    t.slice(0, 300),
  );
  await p.close();
}
p = await open(LIB + "&skill=new&save=superseded");
await typeInto(p, "#k-slug", "trail-notes");
await typeInto(p, "#k-desc", "Use when writing up a walk.");
await typeInto(p, "#k-body", "Note the distance.");
await p.click('[data-k="save"]');
await wait(p);
g = await gwRead(p, "new-trail-notes");
check("S6 R4 new skill, a different read of the receipt's ID: both revisions, no Saved", (await dialog(p)).includes("for your save. The next read found revision " + g.rev.slice(0, 12)) && !(await dialog(p)).includes("Saved revision") && (await p.evaluate(() => window.skills.sent.at(-1).expectedRevision)) === null);
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
check("S6 over the gateway's limit in bytes: said before sending", (await text(p, "#k-body-help")) === "Too long for the gateway: SKILL.md may be at most 1,048,576 bytes, frontmatter included. Letters outside English count as more than one byte." && (await p.evaluate(() => document.querySelector('[data-k="save"]').disabled)));
await p.close();

// Removing (section 7) and sharing (section 8) -------------------------------------------------------
p = await open(LIB + "&skill=trail" + SLOW);
await typeInto(p, "#k-body", "An edit that isn't saved.");
await p.click('[data-k="remove"]');
await wait(p, 120);
check("S7 R1 Remove asks, says what tasks keep, and that the unsaved text stays", has(await confirmText(p), "Remove trail-checklist?", "Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name.", "If the skill is removed, your unsaved text stays here. You can save it as a new skill."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 100);
check("S7 R4 pending: Removing…, and no Removed before the read", (await dialog(p)).includes("Removing…") && !(await dialog(p)).includes("Removed."));
await p.focus("#k-body");
await p.keyboard.type(" More.");
check("S7 R1 during Remove the fields are read-only", (await p.evaluate(() => document.querySelector("#k-body").readOnly && document.querySelector("#k-desc").readOnly)) && (await p.evaluate(() => document.querySelector("#k-body").value)) === "An edit that isn't saved.");
await wait(p);
t = await dialog(p);
check(
  "F-362 S7 R1 removed with unsaved text: said from the read-back, the draft stays, nothing else can be sent",
  t.includes("Removed. Reading your library again: trail-checklist isn't in it. Tasks that have it keep their revision. Your unsaved text is still here.") &&
    (await gwRead(p, "trail")).removed === true &&
    (await p.evaluate(() => document.querySelector("#k-body").value)) === "An edit that isn't saved." &&
    (await p.evaluate(() => ["save", "share", "remove"].every((k) => document.querySelector(`[data-k="${k}"]`).disabled))) &&
    (await announced(p)) === "Removed",
);
await p.click('[data-k="save-as-new"]');
await wait(p, 150);
check("S7 R1 Save text as a new skill takes the draft", (await text(p, "#b-section-title")) === "Save text as a new skill" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "An edit that isn't saved.");
await p.close();
p = await open(LIB + "&skill=trail");
await p.click('[data-k="remove"]');
await wait(p, 120);
check("S7 with nothing unsaved, Remove doesn't mention an edit", !(await confirmText(p)).includes("unsaved"));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
check("F-362 S7 removed: said from the read-back, the row gone", (await dialog(p)).includes("Removed. Reading your library again: trail-checklist isn't in it. Tasks that have it keep their revision.") && !(await p.$('[data-k-skill="trail"]')) && (await gwRead(p, "trail")).removed === true && (await announced(p)) === "Removed");
await p.close();
p = await open(LIB + "&skill=trail&remove=conflict");
await p.click('[data-k="remove"]');
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
g = await gwRead(p, "trail");
check("S7 R4 a stale Remove with nothing unsaved: nothing removed, the page as read again", (await dialog(p)).includes(`The gateway refused this removal because it read a different revision. Reading it again found revision ${g.rev.slice(0, 12)}.`) && !(await dialog(p)).includes("Your unsaved text") && g.removed !== true && (await p.evaluate(() => document.querySelector("#k-body").value)) === g.body);
await p.close();
for (const [mode, words, ann, removed] of [
  ["lost", "Reading the skill again shows it was removed. The gateway did not answer your request. Tasks that hold it keep their pins.", "Removed", true],
  ["lostnot", "Couldn't tell whether it was removed. Reading it again: it is still in your library.", "Not removed", false],
  ["refused", "The gateway answered: Skill library authority changed. Refresh and retry. Reading it again found revision", "Not removed", false],
  ["readfail", "The gateway answered that it removed the skill. Reading the skill again failed. The page still shows the previous read.", "Couldn't read the skill again.", true],
]) {
  p = await open(LIB + "&skill=trail&remove=" + mode);
  await p.click('[data-k="remove"]');
  await p.click('#confirm-dialog [data-b="confirm-ok"]');
  await wait(p);
  t = await dialog(p);
  check(`S7 R4 Remove, ${mode}: the receipt and the read apart`, t.includes(words) && !t.includes("Removed. Reading") && Boolean((await gwRead(p, "trail")).removed) === removed && (await announced(p)) === ann, t.slice(0, 300));
  await p.close();
}
p = await open(LIB + "&skill=trail&remove=readfail");
await typeInto(p, "#k-body", "Kept through a failed read.");
await p.click('[data-k="remove"]');
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
check("S7 R4 Remove whose read fails: the page and the draft stay", (await text(p, "#b-section-title")) === "trail-checklist" && (await p.evaluate(() => document.querySelector("#k-body").value)) === "Kept through a failed read." && (await dialog(p)).includes("Your unsaved text is still here."));
await p.close();
p = await open(LIB + "&skill=trail&remove=conflict");
await typeInto(p, "#k-body", "My route notes, not saved.");
await p.click('[data-k="remove"]');
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
g = await gwRead(p, "trail");
check(
  "S7 R1 a stale Remove with unsaved text: refused, the draft and the gateway's newer text both kept, compared",
  (await dialog(p)).includes(`The gateway refused this removal because it read a different revision. Reading it again found revision ${g.rev.slice(0, 12)}. Your unsaved text is still here.`) &&
    (await p.evaluate(() => document.querySelector("#k-body").value)) === "My route notes, not saved." &&
    (await p.evaluate(() => document.querySelector("[data-k-theirs]")?.textContent)) === g.body &&
    g.body.includes("a head torch") &&
    (await announced(p)) === "Not removed",
);
await p.close();

p = await open(LIB + "&skill=kitchen");
t = await dialog(p);
check("F-363 S8 R6 not shared: what sharing does, for eligible profiles, nothing claimed about others", has(t, "Share on this gateway", "Sharing makes it available to eligible profiles on this gateway: it is listed in their libraries, and their new tasks can begin with it while it is included in defaults. Nothing leaves the gateway.") && !t.includes("No one else has a profile"));
await p.click('[data-k="share"]');
await wait(p, 100);
check("S8 R4 pending: Sharing…, nothing shared yet on the page", (await dialog(p)).includes("Sharing…") && !(await dialog(p)).includes("Shared. Reading"));
await wait(p, 350);
check("S8 R4 after the receipt, before the read: still pending, nothing shared on the page", (await gwRead(p, "kitchen")).shared === true && (await dialog(p)).includes("Sharing…") && !(await dialog(p)).includes("Shared."));
await wait(p);
const kitchenRev = (await gwRead(p, "kitchen")).rev.slice(0, 12);
check(
  "F-363 S8 R6 shared: both reads, each as found, and no claim of who saw it",
  (await text(p, ".k-status")) === `Shared. Reading the skill again, it is shared at revision ${kitchenRev}. The gateway's list of shared skills includes it.` && !/\b(saw|seen|viewed|opened it)\b/i.test(await dialog(p)) && (await announced(p)) === "Shared on this gateway",
);
check("F-363 S8 R4 Share sent the saved revision it showed", (await p.evaluate(() => window.skills.sent.at(-1))).expectedRevision === (await gwRead(p, "kitchen")).rev);
check("F-363 S8 Stop sharing is offered, with what tasks keep", has(await dialog(p), "Stop sharing", "Tasks that have it keep it when you stop sharing."));
await p.click('[data-k="to-list"]');
await wait(p, 120);
check("F-363 S3 the row carries Shared", (await text(p, '[data-k-skill="kitchen"]')).includes("Shared"));
await p.click('[data-k-skill="kitchen"]');
await p.click('[data-k="share"]');
await wait(p);
check("F-363 S8 Stop sharing, from both reads", (await text(p, ".k-status")) === "Not shared. Reading the skill again, it is not shared. The gateway's list of shared skills doesn't include it. Tasks that already have it keep their revision.");
await p.close();
p = await open(LIB + "&skill=kitchen");
check("S8 R4 on a clean page, the line says the request checks the saved revision", (await text(p, "#k-share-saved")) === "Both change sharing for this skill. The request checks the saved revision shown here.");
await typeInto(p, "#k-desc", "Unsaved.");
check("S8 R4 with unsaved text, it adds that the text stays", (await text(p, "#k-share-saved")) === "Both change sharing for this skill. The request checks the saved revision shown here. Your unsaved text stays here.");
await p.close();
// Share after another device saved the skill: the request carries the old revision and is refused.
p = await open(LIB + "&skill=kitchen");
await typeInto(p, "#k-desc", "Keep this as a draft.");
await p.evaluate(() => window.skills.otherSave("kitchen"));
await p.click('[data-k="share"]');
await wait(p);
g = await gwRead(p, "kitchen");
t = await dialog(p);
check(
  "S8 R4 a stale Share: the flag untouched, the refusal and the read, the draft kept on its old base, no success",
  g.shared === false &&
    t.includes(`The gateway refused this request because it read a different revision. Reading it again found revision ${g.rev.slice(0, 12)}, not shared. Your unsaved text stays here.`) &&
    !t.includes("Shared.") &&
    (await p.evaluate(() => document.querySelector("#k-desc").value)) === "Keep this as a draft." &&
    Boolean(await p.$("[data-k-theirs]")),
);
await p.close();
for (const [mode, words] of [
  ["raced", "The gateway accepted the request. The skill is not shared as of the next read."],
  ["split", "The two reads reported different sharing states. Read again."],
  ["readfail", "Couldn't read sharing again. The sharing status shown is from the earlier read."],
  ["lost", "The gateway did not answer this request. Reading the skill again, it is shared at revision"],
]) {
  p = await open(LIB + "&skill=kitchen&share=" + mode);
  await p.click('[data-k="share"]');
  await wait(p);
  t = await dialog(p);
  check(`S8 R6 sharing, ${mode}: the receipt and each read apart, no plain success`, t.includes(words) && !t.includes("Shared. Reading"), t.slice(0, 300));
  await p.close();
}

// Skills in a task (section 9) -----------------------------------------------------------------------
p = await open(TASK);
t = await details(p);
check("S9 R5 the task's skills, each with the task's own revision", await p.evaluate(() => [...document.querySelectorAll(".k-pin")].every((li) => li.querySelector(".k-rev").textContent === window.skills.pins.j1.find((x) => x.skillId === li.querySelector("[data-k-pin]").dataset.kPin).rev.slice(0, 12))));
check("S9 R5 the read's time, and what these are", t.includes("As read at 5:41 PM. The skills this task has saved for its next turns, each at its revision."));
check("S9 R5 an ineligible skill the status reports as disabled: not eligible, never Needs not met", has(t, "Not eligible in the gateway's skill status", "The gateway's skill status for this task lists it as not eligible, and as disabled.") && !t.includes("Needs not met") && !t.includes("Not given"));
check("S9 R2 the bot's filter is shown apart from the pins", t.includes("Juniper's skill filter is the gateway's default, no filter. A filter can leave out a skill this task has; it is set in Juniper's settings, apart from these."));
check("S9 nothing different: no Update", !(await p.$('[data-k="refresh"]')));
await p.click('[data-k-pin="kitchen"]');
await wait(p, 120);
check("S9 a held revision opens read-only, named as the task's", has(await details(p), "the one this task has", "A skill supplies instructions to a bot.") && !(await p.$(".k-held textarea")));
await p.click('[data-k="held-back"]');
await wait(p, 120);
check("S9 R8 Back returns focus to the row that opened it", (await p.evaluate(() => document.activeElement?.dataset.kPin)) === "kitchen");
await p.click('[data-k="attach-open"]');
await wait(p, 100);
check("S9 Attach lists only skills the task doesn't have, each with its revision", has(await details(p), "pack-list", "ridge-safety") && !(await p.$('.k-attach-item[data-value="trail"]')) && (await text(p, '.k-attach-item[data-value="pack"] .k-rev')) === (await gwRead(p, "pack")).rev.slice(0, 12));
const picked = (await gwRead(p, "pack")).rev;
const pickedBody = (await gwRead(p, "pack")).body;
await p.click('.k-attach-item[data-value="pack"]');
// A library save lands between the pick and the answer: what was picked is what is attached.
await p.evaluate(() => window.skills.otherSave("pack"));
await wait(p, 100);
check("S9 R4 pending: Attaching…, no outcome yet", (await details(p)).includes("Attaching…") && !(await details(p)).includes("Attached."));
await wait(p);
g = await p.evaluate(() => window.skills.pins.j1.find((x) => x.skillId === "pack"));
check(
  "S9 R5 attach sends the task key, the skill and the revision shown at the click; the task holds that revision and its text",
  JSON.stringify(await p.evaluate(() => window.skills.sent.at(-1))) === JSON.stringify({ method: "skills.library.activate", sessionKey: "j1", action: "attach", skillId: "pack", revision: picked }) && g.rev === picked && g.body === pickedBody && (await gwRead(p, "pack")).rev !== picked,
);
check("S9 attached: the read's exact revision, from the next turn", (await details(p)).includes(`Attached. Reading the task again, it has revision ${picked.slice(0, 12)}. From this task's next turn.`) && (await announced(p)) === "Attached");
await p.click('[data-k="detach"][data-value="kitchen"]');
await wait(p);
check("S9 detached: from the read", has(await details(p), "Detached. Reading the task again, it no longer has that skill.") && !(await p.$('[data-k-pin="kitchen"]')) && JSON.stringify(await p.evaluate(() => window.skills.sent.at(-1))) === JSON.stringify({ method: "skills.library.activate", sessionKey: "j1", action: "detach", skillId: "kitchen" }));
await p.close();

// Another task chosen while a write is pending: the write keeps its task, and nothing of it shows in the other.
p = await open(TASK);
await p.click('[data-k-pin="kitchen"]');
await wait(p, 100);
await p.evaluate(() => window.app.openTask("juniper", "j3"));
await wait(p, 150);
check("S9 R5 another task doesn't show the first task's held revision", !(await p.$(".k-held")) && (await details(p)).includes("This task has no skills from your library."));
await p.evaluate(() => window.app.openTask("juniper", "j1"));
await wait(p, 150);
check("S9 R5 coming back, the held revision was closed when the task changed", !(await p.$(".k-held")) && Boolean(await p.$('[data-k-pin="kitchen"]')));
await p.click('[data-k="attach-open"]');
await p.click('.k-attach-item[data-value="ridge"]');
await p.evaluate(() => window.app.openTask("juniper", "j3"));
await wait(p);
t = await details(p);
check("S9 R5 a task write keeps its own task when another is opened meanwhile; its outcome isn't shown there", (await p.evaluate(() => window.skills.pins.j1.some((x) => x.skillId === "ridge") && !(window.skills.pins.j3 || []).length)) && !t.includes("Attached") && !t.includes("Attaching"));
await p.evaluate(() => window.app.openTask("juniper", "j1"));
await wait(p, 150);
check("S9 R5 back on the first task, its own outcome is there", (await details(p)).includes("Attached. Reading the task again, it has revision"));
await p.close();

// A full task and a task with nothing left to attach.
p = await open(TASK + "&pins=full");
check("S9 R5 at 64 skills: Attach is disabled, and says why", (await details(p)).includes("This task already has 64 library skills. Detach one to make room.") && (await p.evaluate(() => document.querySelector('[data-k="attach-open"]').disabled)));
await p.close();
p = await open(TASK + "&pins=every");
await p.click('[data-k="attach-open"]');
await wait(p, 100);
check("S9 R5 nothing attachable: the menu says so", (await details(p)).includes("No skills are available to attach."));
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
check("F-361 S9 updated, from the read: from the next turn; the running turn keeps its own", has(t, "Updated. Reading the task again shows these saved revisions, from its next turn. The turn running now keeps the skills it started with.") && !t.includes("Different library revision") && JSON.stringify(await p.evaluate(() => window.skills.sent.at(-1))) === JSON.stringify({ method: "skills.library.activate", sessionKey: "j1", action: "refresh" }));
await p.close();

p = await open(TASK + "&pins=removed");
t = await details(p);
check("S9 R5 a removed skill: told by the gateway's read, blocks Update", has(t, "Removed from the library", "Detach the skills marked unavailable or removed first: the gateway refuses to update a task that has one.") && (await p.evaluate(() => document.querySelector('[data-k="refresh"]').disabled)));
check("S9 R6 a removed entry this connection can read is called removed", (await text(p, '.k-pin:has([data-k-pin="gone"])')).includes("Removed from the library"));
await p.click('[data-k="detach"][data-value="gone"]');
await wait(p, 120);
check("S9 detaching a removed skill says it can't come back", (await confirmText(p)).includes("It was removed from your library, so it can't be attached again."));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
check("S9 Update stays blocked while another removed skill is held", await p.evaluate(() => document.querySelector('[data-k="refresh"]').disabled));
await p.close();
p = await open(TASK + "&pins=removed&access=write");
check(
  "S9 R6 a removed entry this connection could never read stays unavailable to it, not removed",
  (await text(p, '.k-pin:has([data-k-pin="hiddengone"])')).includes("Library entry unavailable") && !(await text(p, '.k-pin:has([data-k-pin="hiddengone"])')).includes("Removed") && (await gwRead(p, "hiddengone")).code === "SKILL_LIBRARY_NOT_FOUND",
);
await p.close();
p = await open(TASK + "&pins=entryfail&access=write");
t = await text(p, '.k-pin:has([data-k-pin="elsewhere"])');
check("S9 R5 a failed read of the entry is said as such, not removed or unavailable", t.includes("Couldn't read the library entry") && !t.includes("Library entry unavailable") && !t.includes("Removed"));
await p.close();
// Read-only: an exact pin this task holds stays readable while its library entry is hidden.
p = await open(TASK + "&pins=unavailable&access=read");
await p.evaluate(() => window.app.openTask("juniper", "j1")); // the read tier starts on the bot's latest task
await wait(p, 150);
await p.click('[data-k-pin="elsewhere"]');
await wait(p, 150);
check("S9 R6 read-only: a pin whose library entry is hidden opens at its exact revision", (await details(p)).includes("the one this task has") && (await p.evaluate(() => document.querySelector("[data-k-held]").textContent)) === "Go anticlockwise." && (await gwRead(p, "elsewhere")).code === "SKILL_LIBRARY_NOT_FOUND");
await p.close();
p = await open(TASK + "&pins=unavailable&access=write");
t = await details(p);
check("S9 R5 an entry this connection can't read is unavailable, not removed", t.includes("Library entry unavailable") && !t.includes("Removed from the library"));
await p.click('[data-k="detach"][data-value="elsewhere"]');
await wait(p, 120);
check("S9 R5 detaching it says it may not come back", (await confirmText(p)).includes("Its library entry isn't available to this connection, so it may not be attachable again."));
await p.close();
for (const [mode, words, ann] of [
  ["refused", "The gateway answered: Session changed before activation; refresh and retry. The skills shown are from the next read.", "Couldn't change the task's skills"],
  ["lost", "Couldn't tell whether the change reached the gateway. Reading the task again, it no longer has that skill.", "Couldn't tell whether it changed"],
  ["readfail", "Couldn't read this task's skills again.", "Couldn't read this task's skills again."],
]) {
  p = await open(TASK + "&taskw=" + mode);
  await p.click('[data-k="detach"][data-value="kitchen"]');
  await wait(p);
  t = await details(p);
  check(`S9 R4 a task write ${mode}: its words, from the read`, t.includes(words) && !t.includes("Nothing changed") && !t.includes("Detached.") && (await announced(p)) === ann, t.slice(0, 300));
  if (mode === "readfail") check("S9 R4 a failed read keeps the last pins and their time", Boolean(await p.$('[data-k-pin="kitchen"]')) && t.includes("As read at 5:41 PM."));
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
check("S10 R2 the gateway's default chosen, and what it is, as configuration", has(t, "Use the gateway's default", "The gateway sets no default skill filter.", "None", "Juniper's configured filter is an empty list.") && (await p.evaluate(() => document.querySelector('[data-k-choice="default"]').getAttribute("aria-checked"))) === "true" && !/Every skill|nothing narrows|is given no skills|decides what/.test(t));
check(
  "S10 R2 a base filter only: a task's overrides, learned skills, eligibility, files",
  (await text(p, "#k-filter-limits")) === "The gateway also applies a task's own skill overrides, which this page doesn't read. Learned skills bypass this filter. Gateway eligibility and skill settings still apply. This filter does not restrict which files the bot's commands can read.",
);
await p.focus('[data-k-choice="default"]');
await p.keyboard.press("ArrowDown");
await wait(p, 150);
check("S13 R8 an arrow moves the choice and keeps focus on it", (await p.evaluate(() => document.activeElement?.dataset.kChoice)) === "only" && (await p.evaluate(() => document.querySelector('[data-k-choice="only"]').getAttribute("aria-checked"))) === "true");
await p.click('[data-k-choice="none"]');
await p.click('[data-k="list-save"]');
await wait(p, 100);
check("S10 R4 pending: Saving…, no Saved yet, and the choices wait", (await tab(p)).includes("Saving…") && !(await tab(p)).includes("Saved.") && (await p.evaluate(() => document.querySelector('[data-k-choice="default"]').getAttribute("aria-disabled"))) === "true");
await p.click('[data-k-choice="default"]', { force: true });
await wait(p);
check("F-199 S10 saved: the configured filter as read again, from each task's next turn; a click while pending changed nothing", (await tab(p)).includes("Saved. Reading again, the configured filter is an empty list. It applies from each task's next turn; a turn running now keeps the skills it started with.") && (await p.evaluate(() => document.querySelector('[data-k-choice="none"]').getAttribute("aria-checked"))) === "true");
await p.click('#panel-settings [data-bs="main"]');
await wait(p, 150);
check("S10 the row reads None after the read-back", (await text(p, '#panel-settings [data-bs="skills"]')).includes("None"));
await p.close();

p = await open(BOT + "&defaults=none");
check("S10 R2 an inherited empty default is named as configuration, with no claim of what the bot is given", (await tab(p)).includes("The gateway's default skill filter is an empty list.") && !(await tab(p)).includes("is given no skills"));
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
check("S10 R2 a name the gateway doesn't list now: apart, and only what these reads show", has(t, "Not in the gateway's lists now", "s_old_route_9b1c2d3e4f5a6b7c8d9e", "No matching skill is listed in these reads. A task may still hold a pin with this command name.") && !t.includes("lets that one through"));
await p.click('[data-k="list-drop"]');
await wait(p, 120);
check("S10 Remove from the filter", !(await tab(p)).includes("s_old_route_9b1c2d3e4f5a6b7c8d9e"));
await p.close();
for (const [mode, words, selected] of [
  ["conflict", "The gateway refused this request. Its answer: config changed since last load; re-run config.get and retry Reading again, the configured filter is an empty list.", "none"],
  ["refused", "The gateway refused this request. Its answer: invalid config: agents.entries.main.skills must be an array of strings Reading again, the configured filter is not set, so the gateway's default applies.", "default"],
  ["lost", "Couldn't tell whether it was saved. Reading again, the configured filter is an empty list.", "none"],
  ["differs", "The gateway answered the request. Reading again found only github.", "none"],
  ["readfail", "The gateway answered the request. Couldn't read the settings again. The filter shown is from the earlier read; your choice is still selected.", "none"],
]) {
  p = await open(BOT + "&cfg=" + mode);
  await p.click('[data-k-choice="none"]');
  await p.click('[data-k="list-save"]');
  await wait(p);
  t = await tab(p);
  check(
    `S10 R4 the filter's write ${mode}: the receipt and the read apart, never a Saved it doesn't establish`,
    t.includes(words) && !t.includes("Saved.") && !t.includes("Nothing was written") && (await p.evaluate(() => document.querySelector('[aria-checked="true"][data-k-choice]').dataset.kChoice)) === selected,
    t.slice(0, 400),
  );
  await p.close();
}
p = await open(BOT + "&access=write");
t = await tab(p);
check("S10 below admin: the value, no Save, the access bar", t.includes("Admin access needed. Changing Juniper's skill filter changes the gateway's settings.") && !(await p.$('[data-k="list-save"]')) && (await p.evaluate(() => document.querySelector('[data-k-choice="default"]').getAttribute("aria-disabled"))) === "true");
await p.close();

// What a bot learned (section 10.2)
p = await open(BOT);
t = await tab(p);
check("S10.2 R7 learned: each change by the actor the gateway records, the review included", has(t, "What Juniper learned", "Saved by Juniper in Weekend walk checklist, 3:04 PM", "Saved by the gateway's review, 2:10 PM", "Learning on its ownOn", "The gateway's documentation says"));
await p.click('[data-k-learned="trail-checklist"]');
await wait(p, 150);
t = await tab(p);
check("S10.2 a learned skill opens read-only, with its changes", has(t, "Its text, as the gateway keeps it", "Clawtrate can read learned instructions here. Editing them is unavailable.", "SKILL.md") && !t.includes("only the bot's own tool") && !(await p.$("#panel-settings textarea")));
await p.click('[data-k="archive"]');
await wait(p, 120);
check("S10.2 Archive asks, and says only what the gateway will do", has(await confirmText(p), "Archive trail-checklist?", "The gateway will move this learned skill into its archive. You can restore it later.") && !(await confirmText(p)).includes("stops being given it"));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p, 100);
check("S10.2 R4 pending: Archiving…, no outcome yet, Archive disabled", (await tab(p)).includes("Archiving…") && !(await tab(p)).includes("Reading again") && (await p.evaluate(() => document.querySelector('[data-k="archive"]')?.disabled !== false)));
await wait(p);
t = await tab(p);
check(
  "F-362 S10.2 archived: from the read, the request captured",
  t.includes("Reading again, trail-checklist is archived.") && (await announced(p)) === "Archived" && JSON.stringify(await p.evaluate(() => window.skills.sent.at(-1))) === JSON.stringify({ method: "skills.workshop.archive", agentId: "juniper", name: "trail-checklist" }),
);
check("S10.2 R8 each saved-versions row says Live or Archived from `live`, and labels each snapshot by its action", (await text(p, '[data-k-archived="trail-checklist"]')).includes("Archived · Archived ") && (await text(p, '[data-k-archived="rest-stops"]')).includes("Live · Kept before a patch, 2:12 PM") && !(await text(p, '[data-k-archived="rest-stops"]')).includes("restore"));
check("S10.2 R8 the mode fact, and only what the documentation and the 50-entry read support", has(t, "Learning on its ownOn", "The gateway's documentation says background review can save or update skills and archive idle ones. This page shows up to 50 recent changes.") && !t.includes("Each change shows here"));
await p.click('[data-k="restore"]');
await wait(p);
t = await tab(p);
check("S10.2 Restore latest saved version, from the read, the actual restore change kept", (await p.evaluate(() => window.skills.sent.at(-1).method)) === "skills.workshop.restore" && t.includes("Reading again, trail-checklist is live for Juniper.") && t.includes("Restored by a person") && !t.includes("restored since"));
await p.close();
p = await open(BOT + "&learned=archived");
t = await tab(p);
check("S10.2 R8 restore is named for what it sends, without a versionId", (await text(p, '[data-k="restore"]')) === "Restore latest saved version");
await p.close();
p = await open(BOT + "&learned=archived&banner=offline");
{
  const before = await p.evaluate(() => window.skills.sent.length);
  check("S10.2 R4 offline: Restore disabled", await p.evaluate(() => document.querySelector('[data-k="restore"]').disabled));
  await p.evaluate(() => document.querySelector('[data-k="restore"]').click());
  await wait(p);
  check("S10.2 R4 offline: a click on Restore sends nothing and changes nothing", (await p.evaluate(() => window.skills.sent.length)) === before && (await p.evaluate(() => window.skills.G.learned.juniper[0].live)) === false);
}
await p.close();
p = await open("bot=juniper&panel=open&tab=settings&bview=learned&banner=offline");
check("S10.2 R4 offline: Archive disabled", await p.evaluate(() => document.querySelector('[data-k="archive"]')?.disabled === true));
await p.close();
p = await open("bot=juniper&panel=open&tab=settings&bview=learned&learnedw=refused");
await p.click('[data-k="archive"]');
await wait(p, 120);
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await wait(p);
t = await tab(p);
check("S10.2 R4 a refused archive: the gateway's reply and the read, apart", has(t, 'The gateway answered: Skill "trail-checklist" is not live.', "Reading again, trail-checklist is live for Juniper.") && (await announced(p)) === "Not archived");
await p.close();
p = await open(BOT + "&learned=archived&learnedw=readfail");
await p.click('[data-k="restore"]');
await wait(p);
t = await tab(p);
check("S10.2 R4 a restore whose next read fails: said as such, nothing concluded", t.includes("Couldn't read Juniper's learned skills again.") && !t.includes("is live for Juniper") && (await announced(p)) === "Couldn't read the learned skills again.");
await p.close();
p = await open(BOT + "&learned=nolive");
t = await tab(p);
check("S10.2 R8 no live rows but saved versions: No live learned skills, not Nothing learned yet", t.includes("No live learned skills.") && !t.includes("Nothing learned yet"));
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
  cards.join("|") === "Saved a skill trail-checklist, Saved to your library|Looked at skills Listed 1 skill., Done|Shared a skill trail-checklist, Shared|Couldn't save a skill trail-checklist, Failed|Learned a skill trail-checklist, Learned",
  cards.join("|"),
);
check("S12 R7 every card has Raw: the call's arguments and the gateway's result", await p.evaluate(() => [...document.querySelectorAll(".k-card")].every((c) => { const r = c.querySelector(":scope > .action-body > .k-raw"); return r && r.textContent.includes("Arguments") && /Result|Error/.test(r.textContent); })));
check("S12 R7 the destination comes from the result's target", await p.evaluate(() => window.CT.skillsCardOf({ args: { action: "create", name: "x", proposal_content: "---\nname: x\ndescription: d\n---\n\nb\n" }, result: JSON.stringify({ state: "published", target: "team", entry: { revision: "a".repeat(64) } }), isError: false }).state === "Saved to the team library"));
{
  const shapes = await p.evaluate(() => {
    const md = "---\nname: x\ndescription: d\n---\n\nb\n";
    const entry = { skillId: "id-x", slug: "x", revision: "c".repeat(64), ownerProfileId: "gateway-owner", shared: false, enabled: true };
    const k = (args, result, isError = false, viewer = "gateway-owner") => {
      const c = window.CT.skillsCardOf({ args, result: result === undefined ? undefined : typeof result === "string" ? result : JSON.stringify(result), isError }, viewer);
      return `${c.verb} | ${c.object} | ${c.state} | ${c.rows.map((r) => r[0]).join(",")}`;
    };
    return {
      unchanged: k({ action: "create", name: "x", proposal_content: md }, { state: "unchanged", target: "personal", entry }),
      filesOnly: k({ action: "update", skill_id: "id-x", expected_revision: "b".repeat(64), files: [{ path: "a.md", content: "a" }] }, { state: "published", target: "personal", entry }),
      read: k({ action: "read", skill_id: "id-x" }, { skillId: "id-x", slug: "x", revision: entry.revision, content: md }),
      view: k({ action: "view", name: "x" }, "---\nname: x\n---"),
      unshare: k({ action: "unshare", skill_id: "id-x", expected_revision: entry.revision }, { state: "published", target: "personal", entry }),
      remove: k({ action: "remove", skill_id: "id-x", expected_revision: entry.revision }, { state: "removed", target: "personal", entry: { ...entry, removed: true } }),
      shareMismatch: k({ action: "share", skill_id: "id-x", expected_revision: entry.revision }, { state: "published", target: "personal", entry }),
      otherProfile: k({ action: "create", name: "x", proposal_content: md }, { state: "published", target: "personal", entry: { ...entry, ownerProfileId: "robin" } }),
      noViewer: k({ action: "create", name: "x", proposal_content: md }, { state: "published", target: "personal", entry }, false, null),
      truncated: k({ action: "list" }, { entries: Array.from({ length: 20 }, (_, i) => ({ slug: `s${i}` })), omitted: 3 }),
      failedShare: k({ action: "share", skill_id: "id-x" }, "Skill changed. Read the current revision and review your edit before saving again.", true),
      pending: k({ action: "create", name: "x", proposal_content: md }, undefined),
    };
  });
  const want = {
    unchanged: "Skill unchanged | x | Unchanged | Name,Use when…,Submitted instructions,Result revision",
    filesOnly: "Updated a skill | x | Saved to your library | Name,Result revision",
    read: "Looked at skills | x | Done | ",
    view: "Looked at skills | x | Done | ",
    unshare: "Stopped sharing a skill | x | Not shared | The tool's recorded result,Result revision",
    remove: "Removed a skill | x | Removed | The tool's recorded result,Result revision",
    shareMismatch: "Used skill workshop | x | Done | ",
    otherProfile: "Saved a skill | x | Saved to a personal library | Name,Use when…,Submitted instructions,Result revision",
    noViewer: "Saved a skill | x | Saved to a personal library | Name,Use when…,Submitted instructions,Result revision",
    truncated: "Looked at skills | Listed 20 skills. 3 omitted. | Done | ",
    failedShare: "Skill action failed |  | Failed | ",
    pending: "Using skill workshop | x | Running | ",
  };
  for (const [name, words] of Object.entries(want)) check(`S12 R7 the adapter, ${name}: its words from the action and the recorded result`, shapes[name] === words, shapes[name]);
}
await p.click("#k-card-saved > summary");
await wait(p, 100);
await p.click("#k-card-saved .k-raw > summary");
await wait(p, 100);
{
  const raw = await p.evaluate(() => JSON.parse(document.querySelector("#k-card-saved .k-raw pre:last-of-type").textContent));
  const initial = await p.evaluate(() => window.skills.G.skills.find((s) => s.id === "trail").history.at(-1).rev);
  check(
    "S12 the saved card's recorded revision: 64 hex, the trail entry's initial read, its prefix on the card",
    /^[0-9a-f]{64}$/.test(raw.entry.revision) && raw.entry.revision === initial && (await text(p, "#k-card-saved .k-card-facts")).includes(`Result revision${raw.entry.revision.slice(0, 12)}`),
  );
  check("S12 R7 the attach line is keyed by the recorded skillId and revision", (await p.evaluate(() => [document.querySelector("#k-card-attach").dataset.kSkillId, document.querySelector("#k-card-attach").dataset.kRev])).join() === [raw.entry.skillId, raw.entry.revision].join());
  check("S12 R7 the card's Raw says it stands for the conversation card's Raw tab", (await text(p, "#k-card-saved .k-raw")).includes("This stands for the action card's Raw tab in the conversation."));
  check("S12 R7 the saved card labels what the arguments carried as Submitted instructions", (await text(p, "#k-card-saved .k-card-facts")).includes("Submitted instructions"));
}
check("S12 S2 the saved card's instructions are text: angle brackets kept, no element inside", await p.evaluate(() => { const pre = document.querySelector("#k-card-saved .k-card-facts pre"); return Boolean(pre) && pre.childElementCount === 0 && pre.textContent.includes("<important>"); }));
await p.click("#k-card-learned > summary");
await wait(p, 100);
check("S12 R7 the learned card shows its instructions", await p.evaluate(() => { const pre = document.querySelector("#k-card-learned .k-card-facts pre"); return Boolean(pre) && pre.textContent.includes("1. Check the forecast for the day of the walk.") && pre.childElementCount === 0; }));
check("S12 R7 the attach line is from this task's read: not held, attachable", (await text(p, "#k-card-attach")).includes("This task doesn't have it: a skill saved during a task isn't added to that task.") && Boolean(await p.$('[data-k="card-attach"]')));
check("S12 R7 the card's revision is still the library's: Use in this task", (await text(p, '[data-k="card-attach"]')) === "Use in this task");
await p.click('[data-k="card-attach"]');
await wait(p, 100);
check(
  "S12 R7 Use in this task sends the actual task, the recorded entry and the card's revision",
  JSON.stringify(await p.evaluate(() => window.skills.sent.at(-1))) === JSON.stringify({ method: "skills.library.activate", sessionKey: "jlearn", action: "attach", skillId: "trail", revision: await p.evaluate(() => document.querySelector("#k-card-attach").dataset.kRev) }),
);
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
p = await open("bot=juniper&task=jlearn");
await p.evaluate(() => {
  window.skills.otherSave("trail");
  window.CT.skillsCards();
});
{
  const now = await p.evaluate(() => window.skills.G.skills.find((s) => s.id === "trail").rev);
  check("S12 R7 the library moved on after the card: it says so, and offers the current revision", (await text(p, "#k-card-attach")).includes(`The library now offers revision ${now.slice(0, 12)}.`) && (await text(p, '[data-k="card-attach"]')) === "Attach current revision");
  await p.click('[data-k="card-attach"]');
  await wait(p);
  const pin = await p.evaluate(() => window.skills.pins.jlearn.find((x) => x.skillId === "trail"));
  const lib = await gwRead(p, "trail");
  check(
    "S12 R7 Attach current revision sends that revision, and the task holds its text",
    (await p.evaluate(() => window.skills.sent.at(-1).revision)) === now && pin.rev === now && pin.body === lib.body && (await text(p, "#k-card-attach")) === `Attached: reading the task again, it has revision ${now.slice(0, 12)} from its next turn.`,
  );
}
await p.close();
p = await open("bot=juniper&task=jlearn&cardread=fail");
check("S12 R7 the task's read failed: said, no button", (await text(p, "#k-card-attach")) === "Couldn't read this task's skills." && !(await p.$('[data-k="card-attach"]')));
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
