// Behaviour checks for controls.html (docs/design/controls.md): what holds each
// rule and the rules plugin's states, the glance, a line's four facts, the one
// contract for asks and saved answers, rules for every bot, saved approvals,
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
check("S1 messaging's row says what Otto may do now", t.includes("May message any bot, asks first"));
check("S1 Memory and Usage sit between Tools and Runs on", await p.evaluate(() => { const g = [...document.querySelectorAll("#panel-settings .b-tabgroup")].map((h) => h.textContent); return g.indexOf("Tools") < g.indexOf("Memory") && g.indexOf("Memory") < g.indexOf("Usage") && g.indexOf("Usage") < g.indexOf("Runs on"); }));
check("S16 the Usage row leads with the budget, the same figure as the totals", t.includes("Budget 1.64M of 2.5M · This week: 1.64M tokens"));
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
check("S4 the glance names Never's actions and the scoped exception", has(await glance(p, "Never"), "Manage routines", "Use the browser", "Change the gateway's settings", "T3 Code", "changing files under secrets/**"));
check("S4 the glance names what asks first, with the command's exception", has(await glance(p, "Asks first"), "Run commands (Review first; always before rm *)", "Message other bots"));
check("S4 the glance names what runs without asking, with its exception", has(await glance(p, "Without asking"), "Change files (not under secrets/**)", "Read files", "Ask you questions"));
check("S7 Never is visible without scrolling at 1440", await p.evaluate(() => document.querySelector(".c-glance-block").getBoundingClientRect().bottom <= innerHeight));
check("S4 a scoped deny makes the line Limited, never Allowed", (await lineText(p, "Change files")).includes("Limited") && (await lineText(p, "Change files")).includes("Never under secrets/**"));
check("S2 a plugin rule is marked as holding only while the plugin runs", (await lineText(p, "Message other bots")).includes("Only while Clawtrate's rules plugin runs"));
check("S2 a gateway rule carries the unqualified mark", (await lineText(p, "Manage routines")).includes("The gateway enforces this"));
check("S2 a gateway setting for every bot carries the lock", (await lineText(p, "Use the browser")).includes("Set on the gateway"));
check("S4 groups in order: Never, Asks first, Without asking", await p.evaluate(() => [...document.querySelectorAll("#panel-settings .b-group")].map((g) => g.textContent).slice(0, 3).join(",") === "Never,Asks first,Without asking"));
check("S2 for these rules to hold: management denied, commands elsewhere, file rules are tool rules", has(t, "Otto can't change the gateway or its plugins: Never.", "Otto's commands run on media-box, not on the gateway's machine.", "A rule about a file tool covers that tool, not the file."));
check("S2 the hold switch says what it is and what it can't do", has(t, "If the rules plugin stops, deny the tools its rules cover", "The gateway doesn't do it by itself, so between the plugin stopping and Clawtrate noticing, these rules aren't enforced."));
check("F-162 F-173 the review switch is on for Otto, and says what off means", (await p.evaluate(() => document.querySelector('[data-c="review"]').getAttribute("aria-checked") === "true")) && t.includes("Off: every such command asks you."));
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
check("S2 stopped: not being enforced right now, with what Otto can do", has(t, "Not being enforced right now.", "3 of Otto's rules need Clawtrate's rules plugin", "Change files under secrets/**", "Message other bots"));
check("S2 stopped: plugin lines read Unknown, Not enforced now", (await lineText(p, "Change files")).includes("Unknown") && (await lineText(p, "Message other bots")).includes("Not enforced now"));
check("S2 holding a scoped rule denies the whole tool, said", t.includes('To hold "never under secrets/**", Clawtrate denies Change files entirely until the plugin runs.'));
await p.click('[data-c="hold"]');
await p.waitForTimeout(100);
t = await panelText(p);
check("S2 deny until it runs: the lines become the gateway's Never", (await lineText(p, "Change files")).includes("Until the rules plugin runs") && (await lineText(p, "Change files")).includes("The gateway enforces this") && t.includes("Denied until the rules plugin runs."));
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
check("S10 a new bot whose restrictive write failed: said, and nothing is sent", (await panelText(p)).includes("Pip's restrictive settings weren't written. It has the gateway's defaults for every bot, which let it run commands without asking. Clawtrate won't send to Pip until they are."));
await p.close();
p = await open("bot=pip&panel=open&tab=settings&newbot=step3");
check("S10 a new bot whose defaults write failed: restrictive, said", (await panelText(p)).includes("Pip is set restrictively: it can't run commands or manage anything."));
await p.close();

// One line, opened (section 5) -------------------------------------------------------------------
p = await open(tab + "&bview=rule&line=exec");
t = await panelText(p);
check("S5 Run commands: four choices, Review first checked", await p.evaluate(() => [...document.querySelectorAll('[data-c="exec"]')].map((r) => r.textContent).join(",") === "Allow all,Review first,Ask,Never" && document.querySelector('[data-c="exec"][aria-checked="true"]').textContent === "Review first"));
check("S2 the four facts: offered, default, own setting, effective", has(t, "Offered", "Default for every bot", "Commands: Never", "Otto's own setting", "Review first. It replaces the default for Otto.", "Effective", "media-box's approvals file"));
check("S3 two checks for commands, neither passing the other", t.includes("Two checks: Clawtrate's rules plugin first, then the gateway's own"));
check("S6 a rule's own version, setting and use", has(t, "Otto's rule, version 1", "Asks every time", "No recorded use"));
check("S5 the line as a whole has no Last used", !t.includes("Last used"));
await p.click('[data-c="exec"][data-value="full"]');
await p.waitForTimeout(80);
check("S5 Allow all asks first, with focus on Cancel", await p.evaluate(() => { const d = document.querySelector("#confirm-dialog"); return d.open && d.textContent.includes("Let Otto run any command without asking?") && document.activeElement.textContent.trim() === "Cancel"; }));
await p.keyboard.press("Escape");
await p.close();
p = await open(tab + "&bview=rule&line=files");
t = await panelText(p);
check("S5 Change files: effective says the exception and who holds it", t.includes("Allowed, except never under secrets/** (the rules plugin)"));
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
await p.click('[data-c="choose"][data-value="never"]');
await p.waitForTimeout(450);
check("S3 saving while a request waits warns that the request will end", (await panelText(p)).includes("changing settings ends a waiting request, so it will not run even if it is answered."));
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
p = await open("bot=otto&task=o1&rules=stopped&held=1");
check("S2 Clawtrate's own hold is a line in the bot's open task", (await text(p, "#transcript")).includes("Clawtrate denied Message other bots, Change files and Run commands for Otto: the rules plugin isn't answering."));
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
check("S6 an ask rule chooses whether answers can be saved", await p.evaluate(() => [...document.querySelectorAll("[data-c-saving] option")].map((o) => o.textContent).join(",") === "Answers can be saved,Ask every time"));
await p.click('[data-c="form-add"]');
await p.waitForTimeout(80);
check("F-174 adding a rule lists it with its version and note", (await panelText(p)).includes("Ask first · matching drafts/**") && (await panelText(p)).includes("Otto's rule, version 1") && (await panelText(p)).includes('Note, not evaluated: "Drafts change often"') && (await announced(p)).includes("Rule added"));
await p.close();
p = await open(tab + "&bview=rule&line=files&form=fromcard");
t = await panelText(p);
const prefilled = await p.evaluate(() => [document.querySelector("[data-c-pattern]").value, document.querySelector("[data-c-action]").value].join("|"));
check("F-328 Make a rule… opens the form filled in from the request, running nothing", prefilled === "notes/disk-2026-11-18.md|allow" && t.includes("Filled in from Otto's expired request at 5:41 PM. Nothing runs: adding this rule changes Otto's future calls only."));
await p.click('[data-c="form-cancel"]');
await p.waitForTimeout(80);
const cancelled = !(await panelText(p)).includes("notes/disk-2026-11-18.md");
await p.click('[data-c="form-open"]');
await p.fill("[data-c-pattern]", "notes/disk-2026-11-18.md");
await p.selectOption("[data-c-action]", "allow");
await p.click('[data-c="form-add"]');
await p.waitForTimeout(80);
check("F-328 the filled form saves only when the person adds the rule", cancelled && (await panelText(p)).includes("Allow · matching notes/disk-2026-11-18.md"));
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

// Messaging (section 11) -------------------------------------------------------------------------
p = await open(tab + "&bview=messaging");
t = await panelText(p);
check("F-130 the effective line comes first", t.includes("Effective: Otto may message any bot."));
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
await p.close();

// Settings, Permissions (sections 7, 8, 9) --------------------------------------------------------
p = await open("open=settings&section=permissions");
const nav = await p.evaluate(() => [...document.querySelectorAll(".b-nav-item")].map((x) => x.textContent));
check("S1 Settings gains Permissions, Memory, Usage and Machines after Integrations", nav.join(",") === "Gateway,Accounts,Integrations,Permissions,Memory,Usage,Machines", nav.join(","));
t = await dialogText(p);
check("S3 ceilings and defaults are told apart", has(t, "Ceilings", "No bot's own settings can grant these back.", "Defaults", "A bot's own setting replaces a default for that bot, wider or narrower."));
check("F-333 set on the gateway, Clawtrate can't change it", t.includes("Set on the gateway. Clawtrate can't change it."));
check("F-177 rules for every bot, with versions", t.includes("Never · Change files under **/.ssh/**") && t.includes("version 1"));
check("S10 a new bot starts restrictive, then these", has(t, "What a new bot starts with", "Review first", "Change the gateway's settings", "Clawtrate writes a new bot restrictively first", "It sends nothing to the bot until the first write is read back."));
await p.close();
p = await open("open=settings&section=permissions&access=write");
check("S7 below admin: the rules' request", (await dialogText(p)).includes("Changing rules for every bot needs admin access."));
await p.close();
p = await open("open=settings&section=permissions&rules=stopped");
check("S7 the plugin stopped: rules for every bot aren't enforced now", (await dialogText(p)).includes("2 rules for every bot aren't enforced now."));
await p.close();

p = await open("open=settings&section=permissions&part=saved");
t = await dialogText(p);
check("F-178 S6 a grant names what it's bound to", has(t, "Change files under notes/** · Otto", "answers Otto's rule 'ask before changing files' (version 2)", "from the request at 5:41 PM", "until 6:41 PM", "used 3 times"));
check("S6 a grant for every bot was made with admin", t.includes("Message other bots: Pip · every bot") && t.includes("made with admin access"));
check("S8 an allowlist entry says it can cover more than the command", t.includes("which can be wider than this exact command"));
check("S8 routine grants and allowlists, each with its holder", has(t, "Routines' grants", "Machines' allowlists", "When it was added isn't recorded.", "The gateway enforces this", "Only while Clawtrate's rules plugin runs"));
await p.click('[data-c="revoke"][data-value="g1"]');
await p.waitForTimeout(60);
check("F-327 Revoke: struck, with when and what follows", (await dialogText(p)).includes("Revoked 5:50 PM. The next matching action asks again") && (await p.$("#settings-dialog .c-struck")) !== null);
await p.close();
p = await open("open=settings&section=permissions&part=saved&access=write");
check("S6 below admin, a grant for every bot can't be revoked", (await dialogText(p)).includes("Revoking a grant for every bot needs admin access."));
await p.close();
p = await open("open=settings&section=permissions&part=saved&saved=ended");
check("S6 a grant ended by its rule's edit stays readable", (await dialogText(p)).includes("Ended: its rule was edited."));
await p.close();
p = await open("open=settings&section=permissions&part=saved&access=read");
check("S8 read-only: the approvals request, not admin", (await dialogText(p)).includes("Seeing saved approvals needs approvals access.") && !(await dialogText(p)).includes("until 6:41 PM"));
await p.close();
p = await open("open=settings&section=permissions&part=saved&saved=empty");
check("S8 empty", (await dialogText(p)).includes("When you choose Always allow on a card, it is listed here."));
await p.close();

p = await open("open=settings&section=permissions&part=activity");
t = await dialogText(p);
check("F-324 each row: time, bot, action, verdict and a labelled cause", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .c-log")].every((x) => x.querySelector(".c-log-time") && x.querySelector(".c-tag") && /^(Recorded|Inferred|Cause not recorded|Needs approvals access)/.test(x.querySelector(".c-log-source").textContent))));
check("S9 recorded, inferred and not recorded are said apart", has(t, "Recorded: a saved approval, change files under notes/** (since revoked)", "Inferred: Marlow's messaging list didn't name Pip", "Cause not recorded"));
check("S9 a recorded rule keeps its version after an edit", t.includes("version 2 (edited since)"));
check("S9 the foot says what the gateway keeps, and there is no Clear", t.includes("The gateway keeps 30 days of activity, up to 100,000 records, without arguments or results.") && !(await p.evaluate(() => [...document.querySelectorAll("#settings-dialog button")].some((x) => /clear/i.test(x.textContent)))));
check("S9 the saved-approval filter is a visible, labelled checkbox", (await p.evaluate(() => document.querySelector("[data-c-grantonly]").closest("label").textContent.trim())) === "Only those allowed by a saved approval");
await p.check("[data-c-grantonly]");
await p.waitForTimeout(60);
check("S9 only those allowed by a saved approval: each names its grant", await p.evaluate(() => { const r = [...document.querySelectorAll("#settings-dialog .c-log-source")].map((x) => x.textContent); return r.length === 2 && r.every((x) => x.startsWith("Recorded: a saved approval")); }));
await p.uncheck("[data-c-grantonly]");
await p.selectOption("[data-c-verdict]", "blocked");
await p.waitForTimeout(60);
check("S9 the verdict filter", await p.evaluate(() => [...document.querySelectorAll("#settings-dialog .c-tag")].every((x) => x.textContent === "Blocked") && document.querySelectorAll("#settings-dialog .c-log").length === 2));
await p.selectOption("[data-c-verdict]", "all");
await p.click('[data-c="older"]');
await p.waitForTimeout(60);
check("S9 Show older adds older records", (await dialogText(p)).includes("Router firmware"));
await p.close();
p = await open("open=settings&section=permissions&part=activity&access=read");
check("S9 read-only: no cause from approvals is shown", (await dialogText(p)).includes("Needs approvals access") && !(await dialogText(p)).includes("Recorded: your answer"));
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
check("S12 each item says stored, and whether it loads", t.includes("Stored, revision 7c1e · Loads into new private tasks; fits its budget") && t.includes("Not loaded; found by search"));
check("S12 both budgets, as meters with numbers", has(t, "MEMORY.md: 1,240 of 20,000 characters.", "All loaded files: 10,800 of 60,000 characters.") && (await p.evaluate(() => document.querySelectorAll('#panel-settings [role="meter"]').length >= 3)));
check("F-212 the loading conditions, in full", has(t, "Not in its routines, helpers, or group and channel tasks, and not text the gateway doesn't trust.", "If you keep your own USER.md on this gateway", "A task already open may keep the earlier copy until it starts again."));
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
check("F-211 an item: stored, loads, searchable, saved by this revision", has(t, "Revision 19bd", "Not loaded; found by search", "This revision found by search at 5:42 PM", "Otto, in 'Disk almost full on the media box', this revision"));
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
check("S12 past its budget: the meter turns danger and says what's cut", (await panelText(p)).includes("1,140 characters at the end aren't loaded.") && (await p.evaluate(() => document.querySelector('#panel-settings .c-meter[data-tone="danger"]') !== null)) && (await panelText(p)).includes("Past the budget: not loaded"));
await p.close();
p = await open(tab + "&bview=memitem&item=n1&mem=over");
await p.click('[data-c="mem-pin"]');
await p.waitForTimeout(80);
check("F-376 moving past the budget is refused, both files unchanged", (await panelText(p)).includes("so the end wouldn't load. Move something out first. Both files are unchanged."));
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
p = await open(tab + "&bview=memory&access=read");
check("S12 read-only: the memory request, once", (await panelText(p)).includes("Changing Otto's memory needs admin access. The gateway lets only admin connections write a bot's files.") && (await p.evaluate(() => document.querySelectorAll("#panel-settings .access-bar").length === 1)));
await p.close();
p = await open("open=settings&section=memory");
t = await dialogText(p);
check("F-213 shared memory names which bots search it, and which don't", t.includes("Searched by Juniper, Marlow, Otto. Not by Pip: its memory search is off."));
await p.click('[data-c="shared-pin"]');
await p.waitForTimeout(60);
check("F-455 copying into every bot's root memory says what it means", await p.evaluate(() => document.querySelector("#confirm-dialog").textContent.includes("Each copy is that bot's own; editing the shared file later doesn't change them. All or nothing.")));
await p.click('#confirm-dialog [data-b="confirm-ok"]');
await p.waitForTimeout(80);
check("F-455 all or nothing: refused whole when one bot is full", (await dialogText(p)).includes("Nothing was copied: Pip's root memory would pass its budget."));
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
check("F-156 a machine's approvals file: defaults, entries, effective", has(t, "Defaults, for bots with no entry of their own", "Its own entry: Ask on every command", "Review first (Otto's policy), then Ask every time (its entry here)"));
check("S15 Allow every command still meets each bot's policy", t.includes('"Allow every command" still meets each bot\'s own policy.'));
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
check("S17 by default a budget is a warning, and says so", t.includes("Shown only") && t.includes("Stopping Otto at the limit needs Clawtrate's budget plugin"));
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
p = await open(tab + "&bview=usage&budget=enforced");
t = await panelText(p);
check("S17 a held budget names the routes it covers and those it doesn't", t.includes("Only while Clawtrate's budget plugin runs") && t.includes("Not for runs on the Codex harness: those are warned only."));
await p.close();
for (const [state, words] of [
  ["unconsented", "the gateway's owner hasn't let it read conversations. This budget is a warning until they do."],
  ["pluginstopped", "The budget plugin isn't running (or is older than this budget needs), so nothing stops Otto at the limit."],
  ["behind", "The plugin's count is from 5:12 PM; runs since then may not be counted, so Otto can pass the limit."],
  ["unenforced", "Otto's budget isn't being enforced now."],
  ["invalid", "Enter a whole number of 1,000 or more."],
]) {
  p = await open(tab + `&bview=usage&budget=${state}`);
  check(`S17 budget ${state}`, (await panelText(p)).includes(words));
  await p.close();
}
p = await open(tab + "&budget=unenforced");
check("S17 a chosen stop that isn't held leads the Usage row", (await panelText(p)).includes("Budget not being enforced now"));
await p.close();
p = await open(tab + "&bview=usage&budget=invalid");
await p.fill("[data-c-budget]", "3000000");
await p.waitForTimeout(60);
await p.click('[data-c="budget-save"]');
check("F-459 raising the budget saves it", (await announced(p)).includes("Budget saved") && (await panelText(p)).includes("1.64M of 3M"));
await p.close();
p = await open("bot=otto&task=o3&budget=enforcedreached");
check("F-397 the plugin refused the run, said with its routes", (await text(p, "#transcript")).includes("Otto didn't start: its weekly budget is used up") && (await text(p, "#transcript")).includes("for runs from apps, channels and the command line"));
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
check("S3 F-334 a refused call says what decided, recorded or inferred", has(t, "Recorded: removed from Otto's tools by Otto's settings (read 5:41 PM).", "Inferred: Otto's settings deny this tool now; Clawtrate didn't read them before this call.", "The gateway's settings changed while it waited."));
check("S18 an answer and its outcome are two lines", has(t, "Your answer: Allowed once, 5:44 PM.", "Then: Didn't run: the gateway's settings changed while it waited.", "Saving it wasn't confirmed."));
check("S6 an expired ask offers a rule, not a grant", t.includes("Expired. Nothing ran.") && t.includes("Make a rule…") && !t.includes("Always allow next time"));
check("F-167 the save form: scope, lifetime, what it covers, Every bot for admin", has(t, "Otto only", "Every bot", "1 hour", "Until revoked", "Saving for every bot needs admin access.", "It answers this rule only, at this version"));
check("S6 an ask that can't be saved offers Allow once and Deny only", has(t, "Each message is asked about."));
check("F-416 at the allow limit Always allow saves and removes nothing, names the limit and links to the rules", has(t, "Always allow will run this once and save nothing: Otto has 20 allow rules and saved answers, the most a scope can hold.", "Your answer: Always allow, 5:41 PM.", "Then: Ran, once.", "Nothing was saved: Otto has 20 allow rules and saved answers, the most a scope can hold. The next identical call asks again.") && (await p.evaluate(() => [...document.querySelectorAll("#controls a.link-button")].filter((a) => a.textContent === "Open the rules list" && a.getAttribute("href").includes("bview=rule&line=files")).length === 2)));
check("F-328 the expired card's Make a rule… is admin's and opens the filled form", has(t, "Make a rule… (admin; below admin it is absent) opens", "It saves only when the person adds the rule, and the expired call never runs.") && (await p.evaluate(() => [...document.querySelectorAll("#controls a")].some((a) => a.getAttribute("href").endsWith("form=fromcard")))));
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
