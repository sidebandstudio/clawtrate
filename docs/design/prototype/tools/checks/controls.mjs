// Behaviour checks for controls.html (docs/design/controls.md): what holds each
// rule and the rules plugin's states, the glance, a line's four facts, the one
// contract for asks and rules, rules for every bot, saved approvals,
// activity and its causes, messaging, memory's three facts, where a bot runs,
// machines, usage and budgets, the conversation's pieces, and the phone width.
// Every check reads visible words, so a changed label fails.
// Run from the repository root:  node docs/design/prototype/tools/checks/controls.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("controls.html") + "?chrome=0&theme=light";
const tab = "bot=otto&panel=open&tab=settings";
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
  await p.waitForTimeout(200);
  return p;
};
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.textContent.replace(/\s+/g, " ") || "", sel);
const panelText = (p) => text(p, "#panel-settings");
const dialogText = (p) => text(p, "#settings-dialog");
const has = (t, ...words) => words.every((w) => t.includes(w));
const announced = async (p) => {
  await p.waitForTimeout(80);
  return p.evaluate(() => document.querySelector("#b-announce").textContent);
};
const glance = (p, title) =>
  p.evaluate((t) => [...document.querySelectorAll(".c-glance-block")].find((b) => b.querySelector("h4").textContent.startsWith(t))?.textContent.replace(/\s+/g, " ") || "", title);
const lineIn = (p, group, words) =>
  p.evaluate(([g, w]) => {
    const h = [...document.querySelectorAll("#panel-settings .b-group")].find((x) => x.textContent === g);
    return Boolean(h && [...h.nextElementSibling.querySelectorAll(".c-line")].some((l) => l.textContent.includes(w)));
  }, [group, words]);
const lineText = (p, words) => p.evaluate((w) => [...document.querySelectorAll(".c-line")].find((l) => l.querySelector(".c-line-words > span").textContent === w)?.textContent.replace(/\s+/g, " ") || "", words);

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// A bot's settings (section 1) --------------------------------------------------------------------
let p = await open(tab);
let t = await panelText(p);
check("S1 the Tools group opens with what Otto may do, its counts whole", has(t, "What Otto may do", "4 never · 2 ask first · 6 without asking"));
check("S1 S11 messaging's row says whom Otto can reach, the recipients' rules included", t.includes("May message Juniper and Marlow, asks first"));
check("S1 Memory and Usage sit between Tools and Runs on", await p.evaluate(() => { const g = [...document.querySelectorAll("#panel-settings .b-tabgroup")].map((h) => h.textContent); return g.indexOf("Tools") < g.indexOf("Memory") && g.indexOf("Memory") < g.indexOf("Usage") && g.indexOf("Usage") < g.indexOf("Runs on"); }));
check("S16 the Usage row leads with the budget, the same figure as the totals", t.includes("Budget 1.64M of 2.5M this week · This week: 1.64M tokens"));
check("S14 Runs on names the command machine", t.includes("Where Otto runs") && t.includes("Commands on media-box"));
await p.close();
p = await open(tab + "&width=phone", { width: 390, height: 844 });
check("S1 phone: counts are never cut", await p.evaluate(() => [...document.querySelectorAll(".c-wrapvalue")].every((v) => v.scrollWidth <= v.clientWidth + 1)) && (await panelText(p)).includes("4 never · 2 ask first · 6 without asking"));
await p.close();

// What a bot may do (sections 2 and 4) -----------------------------------------------------------
p = await open(tab + "&bview=rules");
t = await panelText(p);
check("S2 the rules plugin's state, in words", t.includes("Clawtrate's rules plugin is running (version 1.2). It last checked a call at 5:46 PM."));
check("S4 the glance: Never first, then Asks first, then Without asking", await p.evaluate(() => [...document.querySelectorAll(".c-glance-block h4")].map((h) => h.firstChild.textContent.trim()).join(",") === "Never,Asks first,Without asking"));
check("S4 the glance names Never's actions and the scoped exceptions, the rule for every bot included", has(await glance(p, "Never"), "Manage routines", "Use the browser", "Change the gateway's settings", "T3 Code", "changing files under secrets/** or **/.ssh/**"));
check("S4 S11 the glance names what asks first, with the command's exception and whom Otto can reach", has(await glance(p, "Asks first"), "Run commands (Review first; always before rm *)", "Message other bots (Juniper and Marlow; Pip takes none from Otto)"));
check("S4 the glance names what runs without asking, with both exceptions", has(await glance(p, "Without asking"), "Change files (not under secrets/** or **/.ssh/**)", "Read files", "Ask you questions"));
check("S7 Never is visible without scrolling at 1440", await p.evaluate(() => document.querySelector(".c-glance-block").getBoundingClientRect().bottom <= innerHeight));
check("S4 a scoped deny makes the line Limited, never Allowed", (await lineText(p, "Change files")).includes("Limited") && (await lineText(p, "Change files")).includes("Never under secrets/** or **/.ssh/**"));
check("S2 a plugin rule is marked as holding only while the plugin runs", (await lineText(p, "Message other bots")).includes("Only while Clawtrate's rules plugin runs"));
check("S2 a gateway rule carries the unqualified mark", (await lineText(p, "Manage routines")).includes("The gateway enforces this"));
check("S2 a gateway setting for every bot carries the lock", (await lineText(p, "Use the browser")).includes("Set on the gateway"));
check("S4 groups in order: Never, Asks first, Without asking", await p.evaluate(() => [...document.querySelectorAll("#panel-settings .b-group")].map((g) => g.textContent).slice(0, 3).join(",") === "Never,Asks first,Without asking"));
check("S2 for these rules to hold: management denied, commands elsewhere, file rules are tool rules", has(t, "Otto can't change the gateway or its plugins: Never.", "Otto's commands run on media-box, not on the gateway's machine.", "A rule about a file tool covers that tool, not the file."));
check("S2 no automatic hold is offered", !t.includes("If the rules plugin stops"));
check("F-162 F-173 the review switch is on for Otto, and says what it decides and what off means", (await p.evaluate(() => document.querySelector('[data-c="review"]').getAttribute("aria-checked") === "true")) && t.includes("On: the gateway's reviewer decides commands that aren't on the machine's allowlist") && t.includes("Off: each such command asks you."));
check("F-051 S4 creating a bot meets Otto's command policy, said, with Ask offered", t.includes("Otto has no tool that creates a bot. A command that runs the gateway's command line meets Otto's command policy: Review first.") && (await p.$('[data-c="exec-ask"]')) !== null);
check("S4 tools not offered are listed, folded", await p.evaluate(() => { const d = [...document.querySelectorAll("#panel-settings details")].find((x) => x.textContent.includes("Not offered to Otto")); return d && !d.open && d.textContent.includes("x_search"); }));
await p.click('.c-glance [data-c-line="exec"]');
await p.waitForTimeout(150);
check("S4 a name in the glance opens its line", (await text(p, "#panel-settings .b-subhead h3")) === "Run commands");
await p.click('#panel-settings .b-subhead [data-bs="rules"]');
await p.waitForTimeout(200);
check("S19 Back returns focus to that line", await p.evaluate(() => document.activeElement?.matches('.c-line[data-c-line="exec"]')));
await p.close();

p = await open(tab + "&bview=rules&rules=stopped");
t = await panelText(p);
check("S2 stopped: the plugin's state, never 'the rules plugin enforces this'", t.includes("Clawtrate's rules plugin isn't answering.") && !t.includes("Clawtrate's rules plugin enforces this") && !t.includes("Only while Clawtrate's rules plugin runs"));
check("S2 stopped: what isn't held, every rule that applies, from the last read", has(t, "Not being enforced right now.", "Nothing stops Otto doing these without asking: changing files under secrets/** or **/.ssh/**, messaging other bots, and commands matching rm *.", "Rules as last read on this device, 5:41 PM."));
check("S2 stopped: the hold denies whole tools, and the gap is said", has(t, "Denying them denies Change files, Run commands and Message other bots entirely, in Otto's own settings.", "Until that is read back, nothing stops these."));
check("S2 stopped: plugin lines read Unknown, Not enforced now", (await lineText(p, "Change files")).includes("Unknown") && (await lineText(p, "Message other bots")).includes("Not enforced now"));
check("S4 stopped: Run commands is under Not enforced now, not Asks first, and says what the gateway still does", (await lineIn(p, "Not enforced now", "Run commands")) && !(await glance(p, "Asks first")).includes("Run commands") && (await glance(p, "Not enforced now")).includes("Run commands") && (await lineText(p, "Run commands")).includes("The gateway still reviews first"));
await p.click('[data-c="hold"]');
await p.waitForTimeout(40);
const writing = (await panelText(p)).includes("Writing the deny…") && (await lineText(p, "Change files")).includes("Not enforced now");
await p.waitForTimeout(400);
t = await panelText(p);
check("S2 the hold: lines change only once read back, then the gateway's Never", writing && (await lineText(p, "Change files")).includes("Until the rules plugin runs") && (await lineText(p, "Change files")).includes("The gateway enforces this") && t.includes("Denied until the rules plugin runs.") && t.includes("(read back 5:47 PM)"));
await p.close();
p = await open(tab + "&bview=rules&held=1");
t = await panelText(p);
check("S2 the plugin running again: the hold is still said, with Allow them again", has(t, "Clawtrate's rules plugin is running again.", "Otto's settings still deny Change files, Run commands and Message other bots, which Clawtrate added while it wasn't.", "Removes exactly the entries Clawtrate added."));
await p.click('[data-c="unhold"]');
check("S2 Allow them again removes Clawtrate's own entries", (await announced(p)).includes("Allowed again: Clawtrate removed the entries it added") && (await lineText(p, "Change files")).includes("Limited"));
await p.close();
p = await open(tab + "&bview=rules&held=changed");
check("S2 a deny list changed since the hold: nothing removed by itself, the person chooses", (await panelText(p)).includes("Otto's deny list has changed since Clawtrate added these.") && (await p.evaluate(() => document.querySelectorAll("[data-c-release]").length === 3)) && (await p.$('[data-c="release-chosen"]')) !== null);
await p.close();
p = await open(tab + "&bview=rules&rules=stopped&read=none");
check("S2 never read on this device: can't tell, and nothing to deny", (await panelText(p)).includes("this device has never read its rules, so it can't tell which aren't being enforced.") && (await p.$('[data-c="hold"]')) === null);
await p.close();
p = await open(tab + "&bview=rules&rules=stopped&access=write");
check("S2 below admin: only admin can deny, and nothing stops these until then", (await panelText(p)).includes("Only a connection with admin access can deny these. Until one does, nothing stops these."));
await p.close();
p = await open(tab + "&bview=rules&msg=gateway");
check("S4 S11 the gateway's pairs leave no bot: Never in the glance and the lines, as on the Messaging page", (await glance(p, "Never")).includes("Message other bots (no bot: the gateway's pairs)") && (await lineIn(p, "Never", "Message other bots")) && !(await glance(p, "Asks first")).includes("Message other bots"));
await p.close();
p = await open(tab + "&bview=rules&machine=gatewayhost&cmdpolicy=allowlist");
check("F-051 a policy that isn't Ask is shown as it is, with Ask offered", (await text(p, '[data-testid="create-bot"]')).includes("meets Otto's command policy: Only listed commands.") && (await p.$('[data-c="exec-ask"]')) !== null);
await p.close();
for (const [state, words] of [
  ["noplugin", "Clawtrate's rules plugin isn't installed on this gateway."],
  ["old", "Clawtrate's rules plugin is version 0.9; Otto's rules need 1.0 or newer."],
  ["unchecked", "Checking Clawtrate's rules plugin…"],
]) {
  p = await open(tab + `&bview=rules&rules=${state}`);
  check(`S2 the plugin ${state}: said in words`, (await panelText(p)).includes(words));
  await p.close();
}
p = await open(tab + "&bview=rules&machine=gatewayhost");
check("S2 commands on the gateway's machine: plugin rules are advice", (await panelText(p)).includes("Otto runs commands on the gateway's machine as its user. A command can change the gateway's settings and the rules plugin's store, so Otto's plugin rules are advice until Run commands is Never there or runs elsewhere."));
await p.close();
p = await open(tab + "&bview=rules&rules=loading");
check("S4 loading is busy grey blocks", await p.evaluate(() => document.querySelector('#panel-settings [aria-busy="true"] .skeleton') !== null));
await p.close();
p = await open(tab + "&bview=rules&rules=error");
check("S4 couldn't load, with Try again", (await panelText(p)).includes("Couldn't load what Otto may do") && (await p.$('[data-c="reload"]')) !== null);
await p.close();
p = await open(tab + "&bview=rules&rules=fresh");
check("S4 before the first task", (await panelText(p)).includes("Otto hasn't run yet, so the gateway hasn't listed its tools."));
await p.close();
p = await open(tab + "&bview=rules&rules=stale");
check("S4 the listing is old, labelled Offered", (await panelText(p)).includes("Offered: the gateway's listing for Otto's latest task, Nov 17."));
await p.close();
p = await open(tab + "&bview=rules&override=1");
check("S3 the gateway's deny for every bot overrides the bot's allow", await lineIn(p, "Never", "Search the web"));
await p.close();
p = await open(tab + "&bview=rules&access=read");
t = await panelText(p);
check("S2 read-only: every value, no change, one request", (await glance(p, "Never")).includes("4") && t.includes("Changing Otto's permissions needs admin access.") && (await p.evaluate(() => document.querySelectorAll("#panel-settings .access-bar").length === 1 && document.querySelector('[data-c="review"]').disabled)));
await p.close();
p = await open("bot=pip&panel=open&tab=settings&bview=rules&newbot=step2");
check("S10 a new bot whose restrictive write failed: what the gateway has, as read, and nothing is sent", (await panelText(p)).includes("Pip's restrictive settings weren't written. It has the gateway's defaults for every bot, as read at 5:47 PM: Run commands Never, and nothing denied of its own. Clawtrate won't send to Pip until they are."));
await p.close();
p = await open("bot=pip&panel=open&tab=settings&newbot=step3");
check("S10 a new bot whose defaults write failed: what step 2 left, as read back", (await panelText(p)).includes("Pip is as step 2 left it, read back at 5:47 PM: it can't run commands, and Manage routines, Use the browser, Send messages on channels and its tool servers are denied."));
await p.close();

// One line, opened (section 5) -------------------------------------------------------------------
p = await open(tab + "&bview=rule&line=exec");
t = await panelText(p);
check("S5 Run commands: four choices, Review first checked", await p.evaluate(() => [...document.querySelectorAll('[data-c="exec"]')].map((r) => r.textContent).join(",") === "Allow all,Review first,Ask,Never" && document.querySelector('[data-c="exec"][aria-checked="true"]').textContent === "Review first"));
check("S2 the four facts and Observed: offered, default, own setting, effective as the gateway combines it, observed", has(t, "Offered", "Default for every bot", "Commands: Never", "Otto's own setting", "Review first. It replaces the default for Otto.", "Effective", "Review first: media-box's approvals file asks only for commands not on its allowlist, as Otto's policy does, so the reviewer decides those", "Observed", "Last call 5:44 PM: ran on media-box (its own result)"));
check("S5 Review first is said as the gateway applies it", t.includes("Commands on the machine's allowlist run; the gateway's reviewer decides the rest and asks you when unsure."));
check("S3 two checks for commands, neither passing the other", t.includes("Two checks: Clawtrate's rules plugin first, then the gateway's own"));
check("S6 a rule's own version, setting and use", has(t, "Otto's rule, version 1", "No recorded use") && !t.includes("Answers can be saved"));
check("S5 the line as a whole has no Last used", !t.includes("Last used"));
await p.click('[data-c="exec"][data-value="full"]');
await p.waitForTimeout(80);
check("S5 Allow all asks first, with focus on Cancel", await p.evaluate(() => { const d = document.querySelector("#confirm-dialog"); return d.open && d.textContent.includes("Let Otto run any command without asking?") && document.activeElement.textContent.trim() === "Cancel"; }));
await p.keyboard.press("Escape");
await p.close();
p = await open(tab + "&bview=rule&line=files");
t = await panelText(p);
check("S5 Change files: effective names both exceptions, whose each is, and what holds them", t.includes("Allowed, except never under secrets/** (Otto's rule) or **/.ssh/** (a rule for every bot), only while the rules plugin runs") && t.includes("Last call 5:46 PM: write, finished (its activity record)"));
check("S5 a rule's last decided call links to that exact record", (await p.evaluate(() => document.querySelector('[data-c="to-record"]')?.textContent)) === "Last decided a call: 5:43 PM");
await p.click('[data-c="to-record"]');
await p.waitForTimeout(200);
check("S9 that link opens Activity with that record open", await p.evaluate(() => document.querySelector("#settings-dialog").open && document.querySelector('[data-c="log"][data-value="e3"]')?.getAttribute("aria-expanded") === "true"));
await p.close();
p = await open(tab + "&bview=rule&line=files");
await p.focus('[data-c="choose"][data-value="allow"]');
await p.keyboard.press("ArrowRight");
await p.waitForTimeout(60);
check("S5 an arrow moves and chooses, and the save shows Saving…", (await panelText(p)).includes("Saving…"));
await p.waitForTimeout(450);
check("F-176 Ask saved: says it holds only while the plugin runs", (await panelText(p)).includes("Otto asks you before it changes files. Only while Clawtrate's rules plugin runs.") && (await announced(p)).includes("Saved. Change files: asks first"));
await p.click('[data-c="choose"][data-value="never"]');
await p.waitForTimeout(450);
check("F-176 Never saved: the gateway removes the tools", (await panelText(p)).includes("Otto can't change files. The gateway removes the tools from Otto's tools."));
await p.close();
p = await open(tab + "&bview=rule&line=files&waiting=1");
check("S3 a waiting request is said before any save, as far as it was seen", (await panelText(p)).includes("Otto has a request waiting in 'Disk almost full on the media box'. When a setting was saved while a request waited, the request stayed open but its call didn't run, even when answered.") && (await p.evaluate(() => { const n = [...document.querySelectorAll("#panel-settings .b-note")].find((x) => x.textContent.includes("has a request waiting")); const c = document.querySelector("#panel-settings .c-choice"); return n && c && n.getBoundingClientRect().top < c.getBoundingClientRect().top; })));
await p.close();
p = await open(tab + "&bview=rule&line=exec&rules=stopped");
t = await panelText(p);
check("S5 Run commands stopped: Effective leads with what isn't enforced, never 'Review first' alone", t.includes("Not enforced now: Otto's rule 'Ask first · rm *'. What the gateway still does: review first") && !/Effective ?Review first/.test(t));
await p.close();
p = await open(tab + "&bview=rule&line=exec&rules=stopped&held=1");
t = await panelText(p);
check("S5 Run commands in the hold: Effective is the gateway's Never", t.includes("Never, until the rules plugin runs (Clawtrate's deny in Otto's settings)") && !/Effective ?Review first/.test(t));
await p.close();
p = await open(tab + "&bview=rule&line=exec&override=1");
check("S5 a machine file that asks every time skips the reviewer, said", (await panelText(p)).includes("Every command asks: media-box's approvals file asks every time, so the gateway skips the reviewer"));
await p.close();
p = await open(tab + "&bview=rule&line=files&write=refused");
await p.click('[data-c="choose"][data-value="never"]');
await p.waitForTimeout(200);
check("S5 a refused save keeps the saved value, and says why", (await panelText(p)).includes("Couldn't save: the gateway refused the change. Nothing changed."));
await p.close();
p = await open(tab + "&bview=rule&line=files&write=conflict");
await p.click('[data-c="choose"][data-value="never"]');
await p.waitForTimeout(200);
check("S5 a save crossed by another change shows the gateway's", (await panelText(p)).includes("Someone else changed Otto's settings. This shows what the gateway has now."));
await p.close();
p = await open(tab + "&bview=rule&line=files&write=timeout");
await p.click('[data-c="choose"][data-value="never"]');
await p.waitForTimeout(1200);
check("S5 a save with no answer is checked by reading back", (await panelText(p)).includes("Checked whether this was saved: it was."));
await p.close();
p = await open(tab + "&bview=rule&line=web&override=1");
check("F-333 an overridden allow has no effect and cannot be changed", (await panelText(p)).includes("Otto's own choice, Allow, has no effect while the gateway's settings deny this tool for every bot.") && (await p.evaluate(() => [...document.querySelectorAll('[data-c="choose"]')].every((x) => x.getAttribute("aria-disabled") === "true"))));
await p.close();
p = await open(tab + "&bview=rule&line=files&rules=stopped");
t = await panelText(p);
check("S5 with the plugin stopped: Ask can't be chosen, rules say not enforced now", (await p.evaluate(() => document.querySelector('[data-c="choose"][data-value="ask"]').getAttribute("aria-disabled") === "true")) && t.includes("Not enforced now: the rules plugin isn't running"));
await p.close();
p = await open(tab + "&bview=rule&line=message");
check("S3 an ask's line says Ask first means refused in Otto's routine, and other bots' messages may not ask", (await panelText(p)).includes("Otto has 1 routine, Weekly cleanup. There, Ask first means refused: a routine's run has no one to ask, and the call is refused with no card. The routine's own summary may still say the work was done. When another bot's message starts Otto's run, Otto may not be able to ask; the call is then refused."));
await p.close();
p = await open("bot=pip&panel=open&tab=settings&bview=rule&line=message");
await p.click('[data-c="choose"][data-value="ask"]');
await p.waitForFunction(() => document.querySelector('[data-testid="ask-limits"]'), null, { timeout: 4000 }).catch(() => {});
t = await panelText(p);
check("S3 a bot with no routines is told only about other bots' messages", t.includes("When another bot's message starts Pip's run, Pip may not be able to ask; the call is then refused.") && !t.includes("Ask first means refused"));
await p.close();

p = await open(tab + "&bview=rule&line=exec&cmdpolicy=allowlist");
check("S5 a policy set outside Clawtrate is its own checked value", (await p.evaluate(() => document.querySelector('[data-c="exec"][aria-checked="true"]').textContent)) === "Only listed commands" && (await panelText(p)).includes("set outside Clawtrate. It can be left by choosing another value, not chosen again here."));
await p.close();
p = await open(tab + "&bview=rule&line=exec&cmdpolicy=legacy");
check("S5 a legacy policy is named as given", (await panelText(p)).includes("Legacy setting: security allowlist, ask on miss"));
await p.close();


// The one contract: rules and their limits (section 6) --------------------------------------------
p = await open(tab + "&bview=rule&line=files");
await p.click('[data-c="form-open"]');
await p.waitForTimeout(80);
check("F-174 the form: built from choices, and says why; Add disabled until complete", await p.evaluate(() => { const f = document.querySelector(".c-form"); return f && f.textContent.includes("A rule is built from choices: nothing on the gateway can evaluate a sentence. Add a note in your own words if it helps.") && f.textContent.includes("When Otto wants to: change files") && f.textContent.includes("** across folders") && f.textContent.includes("Note (optional):") && f.textContent.includes("Shown beside the rule. Nothing evaluates it.") && document.querySelector('[data-c="form-add"]').disabled; }));
check("F-174 a rule's note is shown beside it, not evaluated", (await panelText(p)).includes('Note, not evaluated: "Keep keys away"'));
await p.keyboard.type("drafts/**");
await p.selectOption("[data-c-action]", "ask");
await p.waitForTimeout(60);
check("S3 the form for an ask rule says what Ask first means in Otto's routine", (await text(p, ".c-form")).includes("There, Ask first means refused: a routine's run has no one to ask, and the call is refused with no card."));
await p.fill("[data-c-note]", "Drafts change often");
check("S6 an ask rule has no saving choice: no card makes a standing permission", await p.evaluate(() => document.querySelector("[data-c-saving]") === null));
await p.click('[data-c="form-add"]');
await p.waitForTimeout(80);
check("F-174 adding a rule lists it with its version and note", (await panelText(p)).includes("Ask first · matching drafts/**") && (await panelText(p)).includes("Otto's rule, version 1") && (await panelText(p)).includes('Note, not evaluated: "Drafts change often"') && (await announced(p)).includes("Rule added"));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=fromcard");
t = await panelText(p);
const prefilled = await p.evaluate(() => [document.querySelector("[data-c-pattern]").value, document.querySelector("[data-c-action]").value].join("|"));
const o1 = () => p.evaluate(() => window.app.bots.find((b) => b.id === "otto").tasks.find((x) => x.id === "o1").html);
check("F-328 Make a rule… opens the form filled in from the request, and says the Ask rule still applies", prefilled === "notes/disk-2026-11-18.md|allow" && has(t, "Filled in from Otto's expired request at 5:41 PM. The expired call doesn't run.", "Otto's rule 'Ask first · notes/**' still applies, so the next call will still ask until that rule is changed.") && (await p.$('[data-c="asker-allow"]')) !== null && !(await o1()).includes("Otto wrote notes/disk-2026-11-18.md"));
await p.click('[data-c="form-add"]');
await p.waitForTimeout(100);
check("F-328 saving adds the rule, and the next matching call asks, as the form said", (await panelText(p)).includes("Allow · matching notes/disk-2026-11-18.md") && (await panelText(p)).includes("Otto made the same call again: it asked first, as the form said.") && (await p.evaluate(() => window.controls.decide("otto", "files", "notes/disk-2026-11-18.md").verdict)) === "ask");
await p.click('[data-c="show-task"]');
await p.waitForTimeout(150);
check("F-328 the next call is a new card, asked by that rule, and the expired call never ran", (await text(p, '#transcript [data-testid="followup"]')).includes("Asked by Clawtrate's rules plugin: Otto's rule 'Ask first · notes/**'") && !(await text(p, "#transcript")).includes("Otto wrote notes/disk-2026-11-18.md"));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=fromcard");
await p.click('[data-c="asker-allow"]');
await p.waitForTimeout(80);
const changed = (await panelText(p)).includes("No rule asks for this call, so the next one runs without asking.");
await p.click('[data-c="form-add"]');
await p.waitForTimeout(100);
check("F-328 after the Ask rule is changed, the next matching call runs without a card, as the form said", changed && (await panelText(p)).includes("Otto made the same call again: it ran without asking, as the form said.") && (await o1()).includes("Otto wrote notes/disk-2026-11-18.md. No card: no rule asks."));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=fromcard&asker=fallback");
check("F-328 when only the catch-all asked, the Allow rule passes it, said", (await panelText(p)).includes("No rule asks for this call, so the next one runs without asking.") && (await p.$('[data-c="asker-allow"]')) === null);
await p.close();
p = await open(tab + "&bview=rule&line=files&form=fromcard&access=write");
check("F-328 below admin the expired request's rule form doesn't open", (await p.$(".c-form")) === null);
await p.close();
p = await open(tab + "&bview=rule&line=files&form=open&pattern=long");
check("F-332 a 1,001-character pattern is refused, nothing saved", (await panelText(p)).includes("A rule can be at most 1,000 characters. This one is 1,001.") && (await p.evaluate(() => document.querySelector('[data-c="form-add"]').disabled)));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=open&limit=allow");
await p.fill("[data-c-pattern]", "letters/**");
await p.selectOption("[data-c-action]", "allow");
await p.waitForTimeout(60);
check("F-332 S6 a 21st allow rule is refused, never evicting", (await panelText(p)).includes("Otto has 20 allow rules, the most a scope can hold. Remove one to add another.") && (await p.evaluate(() => document.querySelector('[data-c="form-add"]').disabled)));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=open&limit=ask");
await p.fill("[data-c-pattern]", "letters/**");
await p.selectOption("[data-c-action]", "ask");
await p.waitForTimeout(60);
const askFull = (await panelText(p)).includes("Otto has 20 ask rules, the most a scope can hold.");
await p.selectOption("[data-c-action]", "allow");
await p.waitForTimeout(60);
check("F-332 a 21st ask rule is refused, and an allow rule still saves", askFull && (await p.evaluate(() => !document.querySelector('[data-c="form-add"]').disabled)));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=open&limit=never");
await p.fill("[data-c-pattern]", "letters/**");
await p.waitForTimeout(60);
const under = await p.evaluate(() => !document.querySelector('[data-c="form-add"]').disabled);
await p.click('[data-c="form-add"]');
await p.waitForTimeout(80);
await p.click('[data-c="form-open"]');
await p.fill("[data-c-pattern]", "letters2/**");
await p.waitForTimeout(60);
check("S6 never rules are bounded at 50", under && (await panelText(p)).includes("Otto has 50 never rules, the most a scope can hold."));
await p.close();

// A rules-plugin card at the allow limit, answered (F-416), and the command route to a new bot (F-051) ----
p = await open("bot=otto&task=o1&ask=full");
const allowIds = () => p.evaluate(() => window.controls.RULESET.otto.filter((r) => r.action === "allow").map((r) => r.id).join(","));
const idsBefore = await allowIds();
t = await text(p, '#transcript [data-c-card="1"]');
check("F-416 the card offers Allow once and Deny, never Always allow, and says the limit with the way to the rules", has(t, "Allow once", "Deny", "Otto has 20 allow rules, the most a scope can hold.", "Open the rules list") && !(await text(p, "#transcript")).includes("Always allow") && idsBefore.split(",").length === 20);
await p.click('#transcript [data-c-card="1"] [data-c="ask-once"]');
await p.waitForTimeout(450);
t = await text(p, "#transcript");
check("F-416 Allow once runs the call once; the next matching call asks again; nothing saved or removed", has(t, "Your answer: Allowed once, 5:44 PM.", "Then: Ran.", "Nothing was saved and no rule was removed.") && (await p.evaluate(() => document.querySelectorAll('#transcript [data-testid="ran-line"]').length)) === 1 && (await p.$('#transcript [data-c-card="2"][data-state="pending"]')) !== null && (await allowIds()) === idsBefore);
await p.click('#transcript [data-c-card="2"] [data-c="to-rules-list"]');
await p.waitForTimeout(200);
check("F-416 Open the rules list opens Change files' rules", (await text(p, "#panel-settings .b-subhead h3")) === "Change files" && (await panelText(p)).includes("Rules about what it acts on"));
await p.close();
for (const q of ["bot=pip&task=p1&cmd=create", "bot=pip&task=p1&cmd=create&rules=noplugin"]) {
  p = await open(q);
  t = await text(p, '#transcript [data-testid="create-card"]');
  check(`F-051 the command route meets the gateway's own card${q.includes("noplugin") ? ", with no rules plugin" : ""}`, has(t, "openclaw agents add helper", "Asked by the gateway: Pip's command policy, Ask. The command isn't on the gateway machine's allowlist.", "No tool of Pip's creates a bot") && (!q.includes("noplugin") || t.includes("this card is the gateway's own")));
  await p.close();
}
p = await open("bot=pip&panel=open&tab=settings&bview=rules&cmd=create");
check("F-051 a bot on Ask is told, with nothing to change", (await text(p, '[data-testid="create-bot"]')).includes("meets Pip's command policy: Ask.") && (await p.$('[data-c="exec-ask"]')) === null);
await p.close();

// Messaging (section 11) -------------------------------------------------------------------------
p = await open(tab + "&bview=messaging");
t = await panelText(p);
check("F-130 S11 the effective line comes first, the recipients' incoming rules included", t.includes("Effective: Otto may message Juniper and Marlow, asking you first. Pip doesn't take messages from Otto (Pip's incoming rule, only while Clawtrate's rules plugin runs)."));
check("S11 an omitted list reads 'Use the gateway's list'", await p.evaluate(() => document.querySelector('[data-c="msg-out"][aria-checked="true"]').textContent.trim() === "Use the gateway's list"));
check("F-130 outgoing is the gateway's, incoming the plugin's", t.includes("Otto's own list, agentToAgent.send.") && (await p.evaluate(() => [...document.querySelectorAll("#panel-settings .c-sentence")].some((s) => s.textContent.includes("Only while Clawtrate's rules plugin runs")))));
check("F-131 attributed usage only", t.includes("counting only runs a send's result names"));
await p.click('[data-c="msg-out"][data-value="none"]');
await p.waitForTimeout(100);
check("F-311 No bot: saved, and the effective line changes", (await announced(p)).includes("Otto may message no bot") && (await panelText(p)).includes("Effective: Otto may message no bot."));
await p.close();
p = await open(tab + "&bview=messaging&msg=gateway");
t = await panelText(p);
check("S11 the gateway's pairs decide: Otto may message no bot", t.includes("Only these pairs may message each other: Marlow and Pip.") && t.includes("Effective: Otto may message no bot."));
await p.close();
p = await open(tab + "&bview=messaging&msg=some");
await p.click('[data-c-peer="out"][value="pip"]');
await p.waitForTimeout(60);
check("F-310 choosing no bot in Only these is refused", (await panelText(p)).includes("Choose at least one bot, or choose No bot. Nothing is saved until then."));
await p.close();
p = await open(tab + "&bview=messaging&rules=noplugin");
check("F-130 without the plugin, incoming can't be set, and why", (await panelText(p)).includes("Who may message Otto needs Clawtrate's rules plugin running. The gateway only lets each bot limit whom it messages.") && (await p.evaluate(() => document.querySelector('[data-c="msg-in"]').disabled)));
check("S11 without the plugin, the recipient's rule is said as not enforced", (await panelText(p)).includes("Pip has an incoming rule against Otto, which isn't enforced now."));
await p.close();

// Settings, Permissions (sections 7, 8, 9) --------------------------------------------------------
p = await open("open=settings&section=permissions");
const nav = await p.evaluate(() => [...document.querySelectorAll(".b-nav-item")].map((x) => x.textContent));
check("S1 Settings gains Permissions, Memory, Usage and Machines after Integrations", nav.join(",") === "Gateway,Accounts,Integrations,Permissions,Memory,Usage,Machines", nav.join(","));
t = await dialogText(p);
check("S3 ceilings and defaults are told apart", has(t, "Ceilings", "No bot's own settings can grant these back.", "Defaults", "A bot's own setting replaces a default for that bot, wider or narrower."));
check("F-333 set on the gateway, Clawtrate can't change it", t.includes("Set on the gateway. Clawtrate can't change it."));
check("F-177 rules for every bot, with versions", t.includes("Never · Change files under **/.ssh/**") && t.includes("version 1"));
check("F-051 S10 a new bot starts restrictive, then Ask, with no plugin rule", has(t, "What a new bot starts with", "Ask: each command not on the machine's allowlist asks first; listed commands run", "Change the gateway's settings", "Clawtrate writes a new bot restrictively first", "It sends nothing to the bot until the first write is read back.", "None of these needs the rules plugin.") && !t.includes("openclaw"));
await p.close();
p = await open("open=settings&section=permissions&rules=noplugin");
check("F-051 without the rules plugin a new bot's defaults are the same", (await dialogText(p)).includes("Ask: each command not on the machine's allowlist asks first; listed commands run") && !(await dialogText(p)).includes("Review first decides"));
await p.close();
p = await open("open=settings&section=permissions&access=write");
check("S7 below admin: the rules' request", (await dialogText(p)).includes("Changing rules for every bot needs admin access."));
await p.close();
p = await open("open=settings&section=permissions&rules=stopped");
check("S7 the plugin stopped: rules for every bot aren't enforced now", (await dialogText(p)).includes("1 rule for every bot isn't enforced now."));
await p.close();

p = await open("open=settings&section=permissions&part=saved");
t = await dialogText(p);
check("F-178 S8 the gateway's standing approvals, each bound and by id, and none from the plugin", has(t, "The standing approvals the gateway keeps. Clawtrate's rules plugin makes none", "Routine Weekly cleanup (Otto) may run du -sh /srv in /srv", "grant 3f2a", "granted Nov 12", "until Dec 12", "used 4 times") && !t.includes("Change files under notes/**") && !t.includes("Only while Clawtrate's rules plugin runs"));
check("S8 an allowlist entry says it can cover more than the command", t.includes("which can be wider than this exact command") && t.includes("When it was added isn't recorded."));
await p.click('[data-c="revoke"][data-value="rg1"]');
await p.waitForTimeout(60);
check("F-178 Revoke: struck, with when and what follows", (await dialogText(p)).includes("Revoked 5:50 PM. The routine's next matching command no longer runs under this grant.") && (await p.$("#settings-dialog .c-struck")) !== null);
await p.close();
p = await open("open=settings&section=permissions&part=saved&access=write");
check("S8 with approvals and below admin: routine grants, not allowlists", (await dialogText(p)).includes("grant 3f2a") && (await dialogText(p)).includes("Seeing machines' allowlists needs admin access."));
await p.close();
p = await open("open=settings&section=permissions&part=saved&access=read");
check("S8 read-only: the approvals request, not admin", (await dialogText(p)).includes("Seeing saved approvals needs approvals access.") && !(await dialogText(p)).includes("until Dec 12"));
await p.close();
p = await open("open=settings&section=permissions&part=saved&saved=empty");
check("S8 empty", (await dialogText(p)).includes("When a routine's command is allowed for some days, or a command's card adds it to a machine's allowlist, it is listed here."));
await p.close();

p = await open("open=settings&section=permissions&part=activity");
t = await dialogText(p);
check("F-324 each row: time, bot, action, verdict and a labelled cause", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .c-log")].every((x) => x.querySelector(".c-log-time") && x.querySelector(".c-tag") && /^(Recorded|Inferred|Cause not recorded|Needs approvals access)/.test(x.querySelector(".c-log-source").textContent))));
check("S9 recorded, inferred and not recorded are said apart, a grant by its id", has(t, "Recorded: Otto's rule 'never under secrets/**', version 1 (now version 2)", "Inferred: Marlow's messaging list didn't name Pip", "Inferred: routine Weekly cleanup's grant 3f2a for du -sh /srv", "Cause not recorded"));
check("S9 a recorded rule keeps the version it was recorded with", t.includes("version 1 (now version 2)") && !t.includes("version 2 (edited since)"));
check("S9 the foot says what the gateway keeps, and there is no Clear", t.includes("The gateway keeps 30 days of activity, up to 100,000 records, without arguments or results.") && !(await p.evaluate(() => [...document.querySelectorAll("#settings-dialog button")].some((x) => /clear/i.test(x.textContent)))));
check("S9 no filter claims which saved approval let a call run", (await p.$("[data-c-grantonly]")) === null && !t.includes("Only those allowed by a saved approval"));
await p.selectOption("[data-c-verdict]", "blocked");
await p.waitForTimeout(60);
check("S9 the verdict filter", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .c-tag")].every((x) => x.textContent === "Blocked") && document.querySelectorAll("#settings-dialog .c-log").length === 2));
await p.selectOption("[data-c-verdict]", "all");
await p.click('[data-c="older"]');
await p.waitForTimeout(60);
check("S9 Show older adds older records", (await dialogText(p)).includes("Router firmware"));
await p.close();
p = await open("open=settings&section=permissions&part=activity&access=read");
t = await dialogText(p);
check("S9 read-only: causes only from sources read can see", t.includes("Needs approvals access") && !t.includes("Recorded: your answer") && !t.includes("grant 3f2a") && t.includes("Recorded: Otto's rule 'never under secrets/**'"));
await p.close();
p = await open("open=settings&section=permissions&part=activity");
await p.click('[data-c="log"][data-value="e1"]');
await p.waitForTimeout(80);
const noStep = (await dialogText(p)).includes("This step isn't in a task this device has loaded.");
await p.click('[data-c="log"][data-value="e3"]');
await p.waitForTimeout(80);
await p.click('[data-c="show-in-chat"][data-value="e3"]');
await p.waitForTimeout(250);
check("S9 Show in chat opens the task with that step in view and focused", noStep && !(await p.evaluate(() => document.querySelector("#settings-dialog").open)) && (await p.evaluate(() => { const s = document.querySelector('#transcript [data-record="e3"]'); if (!s) return false; const r = s.getBoundingClientRect(); return document.activeElement === s && r.top >= 0 && r.bottom <= innerHeight; })));
await p.close();
for (const [state, words] of [
  ["off", "The gateway isn't recording activity: its audit log is switched off in its settings."],
  ["empty", "No tool activity in the last 30 days."],
  ["partial", "Records before Oct 19 have expired."],
  ["error", "Couldn't load activity"],
]) {
  p = await open(`open=settings&section=permissions&part=activity&audit=${state}`);
  check(`S9 activity ${state}`, (await dialogText(p)).includes(words));
  await p.close();
}
p = await open("open=settings&section=permissions&part=activity&audit=loading");
check("S9 activity loading", await p.evaluate(() => document.querySelector('#settings-dialog [aria-busy="true"]') !== null));
await p.close();

// Memory (sections 12 and 13) --------------------------------------------------------------------
p = await open(tab + "&bview=memory");
t = await panelText(p);
check("F-211 three groups: root memory, about you, notes", has(t, "Root memory", "About you", "Notes"));
check("S12 each item says stored, and whether it loads", t.includes("Stored, revision 7c1e · Loads into new private tasks; fits its budget") && t.includes("Not loaded into tasks") && !t.includes("found by search"));
check("S12 notes are reached by search or by name, and a read by name isn't a search", t.includes("Not loaded into tasks. Otto finds notes by searching its memory, or reads one by name; a read by name doesn't need the index."));
check("S12 both budgets, as meters with numbers", has(t, "MEMORY.md: 1,240 of 20,000 characters.", "All loaded files: 10,800 of 60,000 characters.") && (await p.evaluate(() => document.querySelectorAll('#panel-settings [role="meter"]').length >= 3)));
check("F-212 the loading conditions, in full", has(t, "Not in its routines, helpers, or group and channel tasks, and not text the gateway doesn't trust.", "MEMORY.md is cut in the middle: the gateway keeps the start and the end", "If you keep your own USER.md on this gateway", "A task already open may keep the earlier copy until it starts again."));
check("S12 searchable only once a search returns the revision", t.includes("A revision counts as searchable only once a search returns it."));
await p.click('[data-c="mem-export"]');
check("F-214 Export is announced", (await announced(p)).includes("Exported 7 files"));
await p.click('[data-c="mem-clear"]');
await p.waitForTimeout(60);
check("F-215 Clear names what it removes and what it doesn't", await p.evaluate(() => { const d = document.querySelector("#confirm-dialog"); return d.open && d.textContent.includes("This deletes MEMORY.md and memory/2026-11-17.md, memory/2026-11-16.md and memory/2026-11-12-backup.md.") && d.textContent.includes("It doesn't remove: Otto's chat history; what tasks already running were given; search results until the index refreshes; copies of shared items in other bots"); }));
await p.keyboard.press("Escape");
await p.click('[data-c-item="n1"]');
await p.waitForTimeout(120);
t = await panelText(p);
check("F-211 an item: stored, loads, searchable, saved by this revision", has(t, "Revision 19bd", "Not loaded into tasks. Otto can search for it or read it by name.", "This revision returned by a search at 5:42 PM", "Otto, in 'Disk almost full on the media box', this revision"));
await p.click('[data-c="mem-pin"]');
await p.waitForTimeout(80);
check("F-376 moving a note into root memory", (await panelText(p)).includes("MEMORY.md") && (await announced(p)).includes("Moved to root memory"));
await p.click('#panel-settings .b-subhead [data-bs="memory"]');
await p.waitForTimeout(150);
check("S19 Back returns to the item", await p.evaluate(() => document.activeElement?.dataset.cItem === "n1"));
await p.close();
p = await open(tab + "&bview=memitem&item=n2");
check("S12 an unattributed revision says so", (await panelText(p)).includes("Who saved this revision isn't recorded."));
await p.close();
p = await open(tab + "&bview=memory&mem=over");
check("S12 past its budget: the meter turns danger and says the middle is cut", (await panelText(p)).includes("The gateway keeps the start and the end and leaves out about 1,250 characters from the middle.") && (await p.evaluate(() => document.querySelector('#panel-settings .c-meter[data-tone="danger"]') !== null)) && (await panelText(p)).includes("Over budget: the middle of MEMORY.md isn't loaded") && !(await panelText(p)).includes("at the end"));
await p.close();
p = await open(tab + "&bview=memitem&item=n1&mem=over");
await p.click('[data-c="mem-pin"]');
await p.waitForTimeout(80);
check("F-376 moving past the budget is refused, both files unchanged", (await panelText(p)).includes("so part of its middle wouldn't load. Move something out first. Both files are unchanged."));
await p.close();
p = await open(tab + "&bview=memory&mem=moving");
check("S12 a move that didn't finish shows the item in both places", (await panelText(p)).includes("In root memory and in memory/2026-11-16.md: moving it didn't finish."));
await p.close();
p = await open(tab + "&bview=memitem&item=n2&mem=moving");
check("S12 finish moving or keep both", (await p.$('[data-c="mem-finish"]')) !== null && (await p.$('[data-c="mem-keepboth"]')) !== null);
await p.close();
p = await open(tab + "&bview=memitem&item=m1&mem=edit");
await p.fill("[data-c-memedit]", "The media box is media-box; its disk is /srv, 4 TB.");
await p.click('[data-c="mem-save"]');
await p.waitForTimeout(80);
check("F-212 editing a root item saves a new revision", (await panelText(p)).includes("4 TB") && (await panelText(p)).includes("Revision e4a9") && (await announced(p)).includes("Memory saved"));
await p.close();
p = await open(tab + "&bview=memitem&item=m1&mem=conflict");
check("S12 an edit crossed by another change keeps the text", (await panelText(p)).includes("Otto's memory changed while you were editing. Your text is kept here; the file now has:"));
await p.close();
p = await open(tab + "&bview=memory&mem=noplugin");
check("S12 without the memory plugin: notes read-only", (await panelText(p)).includes("Changing notes needs Clawtrate's memory plugin running.") && !(await p.$('[data-c="mem-import"]')));
await p.close();
for (const [state, words] of [
  ["searchoff", "Search is off for Otto in the gateway's settings."],
  ["nosearch", "Otto's memory search isn't set up on this gateway: Memory provider unavailable. Files are still listed."],
  ["unsearchable", "Not yet confirmed searchable"],
  ["empty", "Otto hasn't saved anything yet."],
  ["import", "6 items from house-notes.md"],
]) {
  p = await open(tab + `&bview=memory&mem=${state}`);
  check(`S12 memory ${state}`, (await panelText(p)).includes(words));
  await p.close();
}
p = await open(tab + "&bview=memitem&item=n1&mem=unsearchable");
check("S12 an unconfirmed note never says found by search", (await panelText(p)).includes("Not confirmed for this revision") && !(await panelText(p)).includes("found by search"));
await p.close();
p = await open(tab + "&bview=memory&access=read");
check("S12 read-only: the memory request, once", (await panelText(p)).includes("Changing Otto's memory needs admin access. The gateway lets only admin connections write a bot's files.") && (await p.evaluate(() => document.querySelectorAll("#panel-settings .access-bar").length === 1)));
await p.close();
p = await open("open=settings&section=memory");
t = await dialogText(p);
check("F-213 shared memory names which bots search it, and which don't", t.includes("Searched by Juniper, Marlow, Otto. Not by Pip: its memory search is off."));
await p.click('[data-c="shared-pin"]');
await p.waitForTimeout(60);
check("F-455 the copy's confirmation promises storage, one bot at a time, not loading", await p.evaluate(() => { const t = document.querySelector("#confirm-dialog").textContent; return t.includes("This adds the text to the root memory file of Juniper, Marlow, Otto and Pip, one bot at a time.") && t.includes("Whether a copy is loaded into a task follows that bot's memory conditions.") && !t.includes("so it loads into") && !t.includes("All or nothing"); }));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await p.waitForTimeout(80);
t = await dialogText(p);
check("F-455 each bot's copy has its own result, kept with the item, with the way on", has(t, "Copied to Juniper, Marlow and Otto. Not copied to Pip: its root memory would pass its budget.", "Try Pip again", "Remove the copies"));
check("F-455 a copied item is listed first", await p.evaluate(() => { const f = document.querySelector("#settings-dialog .c-mems .c-mem"); return f && f.textContent.includes("Quiet hours") && f.textContent.includes("Copied to 3 bots"); }));
await p.close();

// Where a bot runs, and machines (sections 14 and 15) ------------------------------------------
p = await open(tab + "&bview=machine");
t = await panelText(p);
check("F-046 three places: commands, workspace, browser", has(t, "Run Otto's commands on:", "workspaces/otto, on the gateway's machine", "The gateway's shared browser, on the gateway's machine."));
check("S14 commands elsewhere don't move the workspace or the browser", t.includes("On media-box, commands run in media-box's own folder unless a task names one.") && t.includes("Commands running on media-box don't change where the browser is."));
check("F-047 what the settings name is inventory", t.includes("Inventory. Whether Otto can use each isn't reported."));
check("S14 the gateway creates a workspace on its own machine", t.includes("the gateway creates it if it doesn't exist."));
await p.close();
p = await open(tab + "&bview=machine&machine=shared");
check("F-272 a shared workspace leads the page", (await panelText(p)).includes("Otto shares its workspace folder with Pip. Files one bot writes, the other can change."));
await p.close();
p = await open(tab + "&bview=machine&access=read");
check("F-047 below admin, secrets and sign-ins need admin", (await panelText(p)).includes("Needs admin access") && (await panelText(p)).includes("Changing where Otto runs needs admin access."));
await p.close();
p = await open("open=settings&section=machines");
t = await dialogText(p);
check("F-156 a machine's approvals file: defaults, entries, effective as the gateway combines them", has(t, "Defaults, for bots with no entry of their own", "No entry: the defaults", "Review first: commands on the allowlist run, and the reviewer decides the rest"));
check("S15 the gateway's rule for combining, and Allow every command still meets each bot's policy", t.includes("The gateway takes the stricter of a bot's policy and this file, and the more asking of the two; it uses a bot's reviewer only when this file doesn't ask more.") && t.includes('"Allow every command" still meets each bot\'s own policy.'));
await p.close();
p = await open("open=settings&section=machines&override=1");
check("F-156 an entry that asks every time skips the reviewer, said", (await dialogText(p)).includes("Its own entry: Ask on every command") && (await dialogText(p)).includes("Every command asks: its entry here asks every time, so the gateway skips Otto's reviewer"));
check("F-157 machines and paired devices", has(t, "media-box", "Last seen", "This device", "Clawtrate on iPhone"));
await p.close();
p = await open("open=settings&section=machines&access=write");
check("S15 below admin the approvals file isn't shown", (await dialogText(p)).includes("Seeing a machine's approvals needs admin access.") && !(await dialogText(p)).includes("Its own entry"));
await p.close();
p = await open("open=settings&section=machines&devices=noscope");
check("S15 paired devices below device access: the device request", (await dialogText(p)).includes("Managing paired devices needs device access."));
await p.close();

// Usage and budgets (sections 16 and 17) --------------------------------------------------------
p = await open(tab + "&bview=usage");
t = await panelText(p);
check("S16 the budget comes before the figures", await p.evaluate(() => { const g = [...document.querySelectorAll("#panel-settings .b-group")].map((x) => x.textContent); return g.indexOf("Budget") < g.indexOf("Usage"); }));
check("S17 a budget is a warning, and says so", t.includes("Shown only") && t.includes("nothing on the gateway stops Otto at the limit") && !t.includes("budget plugin"));
check("S16 the budget and the totals are the same figure", t.includes("1.64M of 2.5M tokens this week") && t.includes("1,640,000 tokens"));
check("F-232 the cost is the gateway's estimate, with source and age", t.includes("About $3.29") && t.includes("The gateway's estimate from its configured prices, in US dollars, as of 5:41 PM."));
check("F-131 F-237 by source, with Not attributed", has(t, "Messages from other bots", "Not attributed", "never charged to one message"));
check("F-233 what fills the context isn't reported", t.includes("What fills it isn't reported"));
await p.close();
for (const [state, words] of [
  ["partial", "Partial: 2 runs have no price configured."],
  ["nocost", "Cost unavailable for scripted/dev-1: the gateway has no price for it."],
  ["computing", "Still being counted"],
]) {
  p = await open(tab + `&bview=usage&usage=${state}`);
  check(`F-232 usage ${state}`, (await panelText(p)).includes(words));
  await p.close();
}
p = await open(tab + "&bview=usage&budget=warn");
check("F-396 at 82 percent: the meter warns, with numbers", (await panelText(p)).includes("1.64M of 2M tokens this week") && (await p.evaluate(() => document.querySelector('#panel-settings .c-meter[data-tone="warn"] [role="meter"]') !== null)));
await p.close();
p = await open(tab + "&bview=usage&budget=reached");
check("F-397 a warning budget used up holds back Clawtrate's own sends, and says what it doesn't stop", (await text(p, ".c-composer-note")).includes("other apps, channels and Otto's routines aren't stopped."));
await p.close();
for (const state of ["", "none", "warn", "reached", "daily", "invalid"]) {
  p = await open(tab + `&bview=usage${state ? `&budget=${state}` : ""}`);
  t = await panelText(p);
  check(`S17 budget ${state || "default"}: never says it stops Otto, or that a stop isn't enforced`, !t.includes("Stops Otto at the limit") && !t.includes("isn't being enforced now") && !t.includes("budget plugin") && (state !== "invalid" || t.includes("Enter a whole number of 1,000 or more.")));
  await p.close();
}
p = await open(tab + "&bview=usage&budget=daily");
check("S17 a Daily budget is labelled and counted daily", (await text(p, "#panel-settings .c-meter-text")).includes("of 400k tokens today") && (await panelText(p)).includes("Resets at 00:00, your time."));
await p.close();
p = await open(tab + "&bview=usage");
await p.click('[data-c="budget-edit"]');
await p.click('[data-c="budget-kind"][data-value="daily"]');
await p.fill("[data-c-budget]", "300000");
await p.waitForTimeout(60);
await p.click('[data-c="budget-save"]');
await p.waitForTimeout(80);
check("S17 saving a Daily budget shows it daily, not weekly", (await text(p, "#panel-settings .c-meter-text")).includes("of 300k tokens today") && !(await text(p, "#panel-settings .c-meter-text")).includes("this week"));
await p.close();
p = await open(tab + "&bview=usage&budget=invalid");
await p.fill("[data-c-budget]", "3000000");
await p.waitForTimeout(60);
await p.click('[data-c="budget-save"]');
check("F-459 raising the budget saves it", (await announced(p)).includes("Budget saved") && (await panelText(p)).includes("1.64M of 3M"));
await p.close();
p = await open("bot=otto&task=o3&budget=reached");
check("F-397 nothing says a run was refused by a budget; only this device's sends are held", !(await text(p, "#transcript")).includes("didn't start") && (await text(p, ".c-composer-note")).includes("This is shown only"));
await p.close();
p = await open("bot=otto&task=o3&budget=warn");
check("F-396 the 80 percent line agrees with the budget", (await text(p, "#transcript")).includes("Otto has used 82% of its weekly budget: 1.64M of 2M tokens."));
await p.close();
p = await open("open=settings&section=usage");
t = await dialogText(p);
check("F-235 provider limits carry their time and no account", t.includes("OpenAI · Weekly · 62% used · resets Nov 20 · as of 5:40 PM") && t.includes("Neither says which of your accounts it is about."));
await p.close();
p = await open("bot=otto&plimit=near");
check("F-236 near a provider's limit: no account is named", (await text(p, ".c-composer-note")).includes("OpenAI reports 92% of a weekly limit used, as of 5:40 PM. It doesn't say which of your OpenAI accounts."));
await p.close();
p = await open("bot=otto&task=o1&saveline=1");
await p.click('[data-c="saved-to-memory"]');
await p.waitForTimeout(200);
check("F-110 Saved to memory opens that item", (await panelText(p)).includes("Disk at 91% after the camera import."));
await p.close();

// The gallery's Controls section ----------------------------------------------------------------
p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => out.push("PAGEERROR " + e));
await p.goto(pageUrl("gallery.html") + "?chrome=0&theme=light&section=controls");
await p.waitForTimeout(200);
t = await text(p, "#controls");
check("S3 F-334 a not-found call's cause is inferred, never recorded; a generic error names none", has(t, "Inferred: Otto's settings denied this tool when Clawtrate read them at 5:41 PM. The gateway's answer, not found, doesn't say why.", "Cause not recorded. The gateway answered 'Tool exec not found'.", "Cause not recorded. The gateway answered 'Plugin approval required (gateway unavailable)'.") && !t.includes("Recorded: removed from") && !t.includes("settings changed while it waited."));
check("S18 an answer and its outcome are two lines", has(t, "Your answer: Allowed once, 5:44 PM.", "Then: Didn't run. The gateway answered 'Plugin approval required (gateway unavailable)'.") && !t.includes("Saving it wasn't confirmed."));
check("S6 an expired ask offers a rule, not a grant", t.includes("Expired. Nothing ran.") && t.includes("Make a rule…") && !t.includes("Always allow next time"));
check("S6 no rules-plugin card offers Always allow; an ask offers Make a rule…", (await p.evaluate(() => [...document.querySelectorAll("#controls button")].filter((b) => /Always allow/.test(b.textContent)).length)) === 0 && has(t, "Make a rule…", "the gateway tells the plugin the decision alone, so no card makes a standing permission"));
check("S6 a messaging ask offers Allow once and Deny only", has(t, "Each message is asked about.", "Each message is its own decision"));
check("F-416 the card at the limit says so, with the way to the rules, and is answerable live", has(t, "Otto has 20 allow rules, the most a scope can hold.", "Nothing was saved and no rule was removed.") && (await p.evaluate(() => [...document.querySelectorAll("#controls a.link-button")].some((a) => a.textContent === "Open the rules list" && a.getAttribute("href").includes("bview=rule&line=files")) && [...document.querySelectorAll("#controls a")].some((a) => a.getAttribute("href").endsWith("ask=full")))));
check("F-328 the expired card's Make a rule… is admin's and opens the filled form", has(t, "Make a rule… (admin; below admin it is absent) opens", "which says what the rule will change given the rules already there", "It saves only when the person adds the rule, and the expired call never runs.") && (await p.evaluate(() => [...document.querySelectorAll("#controls a")].some((a) => a.getAttribute("href").endsWith("form=fromcard")))));
check("S17 the budget lines claim no refused run", !t.includes("didn't start"));
check("F-311 F-436 the Messaged card's policy states", has(t, "Otto may not message Marlow: Otto's messaging settings. The gateway enforces this.", "Set on the gateway. Nothing was sent.", "held by Clawtrate's rules plugin", "You denied the approval. Nothing was sent."));
const links = await p.evaluate(() => [...document.querySelectorAll("#controls .c-state-links a")].map((a) => a.getAttribute("href")));
check("S23 every state of controls.html is linked from the gallery", links.length >= 113 && links.every((h) => h.startsWith("controls.html?")), String(links.length));
await p.close();

// Phone, themes, motion (section 19) -------------------------------------------------------------
p = await open(tab + "&bview=rules&width=phone", { width: 390, height: 844 });
check("S7 phone: Never is visible without scrolling", await p.evaluate(() => { const n = [...document.querySelectorAll(".c-glance-block")].find((b) => b.querySelector("h4").textContent.startsWith("Never")); return n && n.getBoundingClientRect().bottom <= innerHeight; }));
check("S19 phone: the glance stacks", await p.evaluate(() => { const r = [...document.querySelectorAll(".c-glance-block")].map((b) => b.getBoundingClientRect().left); return new Set(r.map(Math.round)).size === 1; }));
check("S19 phone: a line's words never shorten", await p.evaluate(() => [...document.querySelectorAll(".c-line-words > span")].every((s) => s.scrollWidth <= s.clientWidth + 1)));
await p.close();
p = await open(tab + "&bview=rules&rules=stopped&width=phone", { width: 390, height: 844 });
check("S19 phone, plugin stopped: the whole glance, Not enforced now included, is on the first screen", await p.evaluate(() => { const b = [...document.querySelectorAll(".c-glance-block")]; return b.length === 4 && b.every((x) => x.getBoundingClientRect().bottom <= innerHeight); }), await p.evaluate(() => String(Math.round([...document.querySelectorAll(".c-glance-block")].pop().getBoundingClientRect().bottom))));
await p.close();
p = await open(tab + "&bview=rule&line=exec&width=phone", { width: 390, height: 844 });
check("S19 phone: choices 44 px or taller, four in two rows", await p.evaluate(() => { const r = [...document.querySelectorAll('[data-c="exec"]')].map((x) => x.getBoundingClientRect()); return r.every((x) => x.height >= 44) && new Set(r.map((x) => Math.round(x.top))).size === 2; }));
await p.close();
p = await open("open=settings&section=permissions&part=activity&width=phone", { width: 390, height: 844 });
check("S7 phone: the filters never cover the first row", await p.evaluate(() => document.querySelector(".c-filters[role=group]").getBoundingClientRect().bottom <= document.querySelector(".c-log").getBoundingClientRect().top));
check("S7 phone: every filter is fully visible", await p.evaluate(() => { const band = document.querySelector(".c-filters[role=group]").getBoundingClientRect(); return [...document.querySelectorAll(".c-filters[role=group] > *")].every((x) => { const r = x.getBoundingClientRect(); return r.left >= band.left - 1 && r.right <= band.right + 1; }); }));
check("S7 phone: every tag stays inside its row, uncut", await p.evaluate(() => [...document.querySelectorAll(".c-log")].every((row) => { const tag = row.querySelector(".c-tag"); const a = row.getBoundingClientRect(); const r = tag.getBoundingClientRect(); return r.right <= a.right + 1 && tag.scrollWidth <= tag.clientWidth + 1; })));
await p.close();
p = await b.newPage({ viewport: { width: 1440, height: 900 } });
p.on("pageerror", (e) => out.push("PAGEERROR " + e));
await p.goto(pageUrl("controls.html") + "?chrome=0&theme=dark&" + tab + "&bview=rules");
await p.waitForTimeout(200);
check("S19 dark: the page renders on the dark tokens", await p.evaluate(() => document.documentElement.dataset.theme === "dark" && document.querySelectorAll(".c-line").length === 12));
await p.close();
p = await open(tab + "&bview=rules&rules=loading&motion=reduce");
check("S19 reduced motion: skeletons are still", await p.evaluate(() => getComputedStyle(document.querySelector("#panel-settings .skeleton")).animationName === "none"));
await p.close();

await b.close();
console.log(out.join("\n"));
const oks = out.filter((l) => l.startsWith("ok")).length;
console.log(`\n${oks} ok, ${failed} not ok`);
process.exit(failed || out.some((l) => l.startsWith("PAGEERROR")) ? 1 : 0);
