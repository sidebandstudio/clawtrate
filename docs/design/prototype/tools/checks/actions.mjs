// Behaviour checks for the action cards (conversation.md, sections 7, 8 and 11):
// the gallery's sections, the three test runs, and the scripted run.
// Run from the repository root:  node docs/design/prototype/tools/checks/actions.mjs
import { chromium, pageUrl } from "./browser.mjs";

const gallery = (section, extra = "") => pageUrl(`gallery.html?chrome=0&theme=light&section=${section}${extra}`);
const scene = (name, extra = "") => pageUrl(`conversation.html?chrome=0&theme=light&scene=${name}${extra}`);
const run = pageUrl("conversation.html?chrome=0&theme=light");
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name} ${ok ? "" : extra}`);

async function open(url, { w = 1440, h = 900 } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => out.push("PAGEERROR " + String(e.stack || e).split("\n").slice(0, 2).join(" | ")));
  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(100);
  return p;
}
const q = (p, fn, arg) => p.evaluate(fn, arg);
const words = (p, sel) => q(p, (s) => [...document.querySelectorAll(s)].map((c) => c.querySelector(":scope > summary").innerText.replace(/\s+/g, " ").trim()), sel);

// Every kind, in order, with nothing opened (F-488) -------------------------------------------
let p = await open(gallery("actions"));
const first = await words(p, ".spec:first-of-type .spec-box > details.card");
const expected = [
  "Read backup-2026-11-15.log",
  "Looked in archive",
  "Edited house-log.md",
  "Saved to memory",
  'Searched memory for "boiler service"',
  "Ran du",
  'Searched the web for "cold climate heat pump performance"',
  'Searched posts on X for "heat pump rebate 2026 experiences"',
  "Opened energy.example.org",
  'Clicked "Add to basket"',
  "Looked at the screen",
  "Created routine Weekly cleanup",
  "Messaged Marlow",
  "Looked through tasks",
  "Started a helper: Price check",
  "Asked you a question",
  "Made a plan",
  "Made an image",
  "Messaged Dana on Telegram",
  "Used linear",
  "Messaged T3 Code",
  "Used skills search",
];
check("F-488 every kind shows its label, in order", expected.length === first.length && expected.every((label, i) => first[i].startsWith(label)), JSON.stringify(first.map((f, i) => [expected[i], f])));
check("F-488 nothing is opened and no Raw is on screen", await q(p, () => ![...document.querySelectorAll(".spec:first-of-type details")].some((d) => d.open) && [...document.querySelectorAll(".spec:first-of-type [role='tabpanel']")].every((t) => !t.checkVisibility())));
check(
  "F-430 a closed card has a verb, an icon, an object, a detail and a state",
  await q(p, () => [...document.querySelectorAll(".spec:first-of-type .action")].every((c) => c.querySelector(".action-verb").textContent && c.querySelector(".action-what > .icon, .action-what > .agent-mark") && c.querySelector(".action-state"))),
);
check("one line, 40 px, at desktop width", await q(p, () => [...document.querySelectorAll(".spec:first-of-type .action > summary")].every((s) => Math.round(s.getBoundingClientRect().height) === 40)));
check(
  "cards in a row form a column: 2 px apart, 6 px touching corners",
  await q(p, () => {
    const [a, c] = document.querySelectorAll(".spec:first-of-type .action");
    const gap = Math.round(c.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
    return gap === 2 && getComputedStyle(a).borderTopLeftRadius === "18px" && getComputedStyle(a).borderBottomLeftRadius === "6px" && getComputedStyle(c).borderTopLeftRadius === "6px";
  }),
);
check("a running card has the working mark in place of its icon, and the present tense", await q(p, () => [...document.querySelectorAll(".spec:nth-of-type(2) .action")].every((c) => c.querySelector(".action-what > .glyph[data-state='working']") && /^(\w+ing|Starting)/.test(c.querySelector(".action-verb").textContent))));
check("a failed card says Couldn't and Failed", await q(p, () => [...document.querySelectorAll(".spec:nth-of-type(3) .action")].every((c) => c.querySelector(".action-verb").textContent.startsWith("Couldn't") && c.querySelector(".state[data-tone='danger']"))));
const states = await words(p, ".spec:nth-of-type(4) .spec-box > details.card");
check(
  "one card in every state, in words the gateway can establish",
  ["Running mv", "Reviewing mv", "Wants to run mv", "Ran du", "Ran grep", "Couldn't run mv", "Timed out: rsync", "Didn't run mv", "Blocked by policy", "Blocked by review", "Stopped running mv", "Stopped sending a message on Telegram", "Messaged Dana on Telegram"].every((label, i) => states[i]?.startsWith(label)) &&
    states[4].includes("exit 1") && states[11].includes("Unknown") && states[12].includes("Call made") && !states.some((s) => /Sending\b(?! a message)/.test(s) || /\bSent\b/.test(s)),
  JSON.stringify(states),
);
check("a non-zero exit code is plain text, not a failure", await q(p, () => { const c = [...document.querySelectorAll(".spec:nth-of-type(4) .action")][4]; return c.dataset.status === "done" && getComputedStyle(c.querySelector(".action-exit")).color === getComputedStyle(document.body).color; }));
check("last seen: nothing that stands for work moves", await q(p, () => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest("[data-connection='lost']")).length === 0 && document.querySelectorAll("[data-connection='lost'] .state").length === 2));
check("text beside a tool call is a bubble that ends the column", await q(p, () => { const box = [...document.querySelectorAll(".spec")][5].querySelector(".spec-box"); const kids = [...box.children].map((c) => c.className.split(" ")[0]); return kids.join(",") === "msg,card,card,msg,card"; }));

// Levels: open a card, Raw is one step further ----------------------------------------------------
const readable = await q(p, () => { const c = [...document.querySelectorAll(".spec")][6].querySelector(".action"); return [c.open, c.querySelector("[role=tab][aria-selected=true]").textContent, !!c.querySelector("[data-view='readable'] .code-block")]; });
check("level 1: an opened card shows its readable view", readable[0] && readable[1] === "Readable" && readable[2]);
check("level 2: Raw holds the tool, arguments, result, timing and ids", await q(p, () => { const raw = [...document.querySelectorAll(".spec")][7].querySelector("[data-view='raw']"); const t = raw.textContent; return !raw.hidden && ["Tool", "Arguments", "Result", "Timing", "Identifiers"].every((w) => t.includes(w)) && raw.querySelector(".tool-name").textContent === "read"; }));
check("level 2: the reasoning that led to an action is inside its card, under a Thought line", await q(p, () => { const c = [...document.querySelectorAll(".spec")][8].querySelector(".action"); const t = c.querySelector(".action-thought .thought"); return !!t && t.querySelector("summary").textContent.startsWith("Thought for 4s") && t.textContent.includes("71 minutes"); }));
await p.click(".spec:nth-of-type(7) .action [data-view-button='raw']");
check("the Raw tab switches the view in place", await q(p, () => !document.querySelector(".spec:nth-of-type(7) .action [data-view='raw']").hidden));
check("read-only: a call waiting for approval says so, and the question is a card", await q(p, () => { const box = [...document.querySelectorAll(".spec")].at(-1); const t = box.innerText.replace(/\s+/g, " "); return t.includes("Waiting for approval") && t.includes("Asking you a question") && t.includes("Request access"); }));
await p.close();

// Folds -------------------------------------------------------------------------------------------
p = await open(gallery("folds"));
const folds = await words(p, ".spec:first-of-type .action");
check("F-488 a run of six reads is one card", folds[0].startsWith("Read 6 files"), folds[0]);
check(
  "folds of other kinds read as one line with a count",
  ['Searched the web 3 times', "Edited 3 files", "Used the browser 4 actions", "Looked in memory 2 times", "Updated the plan 3 times"].every((label, i) => folds[i + 1].replace(" · ", " ").startsWith(label)),
  JSON.stringify(folds),
);
check("a fold sums an edit's lines", folds[2].includes("+") && folds[2].includes("−"), folds[2]);
check("a fold with an action running names it", (await words(p, ".spec:nth-of-type(2) .action"))[0].includes("reading"));
const failed = await q(p, () => { const c = document.querySelector(".spec:nth-of-type(4) .action"); return [c.open, c.querySelector(".action-detail").textContent, c.querySelector(".action-state").textContent, c.querySelector(".action-detail").dataset.tone]; });
check("F-092 a failure inside a closed fold is named on its line", !failed[0] && failed[1].includes("couldn't read backup-2026-11-08.log") && failed[2].includes("1 failed") && failed[3] === "danger", JSON.stringify(failed));
check("level 1 of a fold: one row per action, in the singular", await q(p, () => { const rows = [...document.querySelectorAll(".spec:nth-of-type(5) .fold-rows .step")]; return rows.length === 3 && rows[1].dataset.status === "failed" && rows[0].querySelector(".step-title").textContent.startsWith("Read ") && rows.every((r) => r.querySelector("[role=tab]")); }));
check("a row in a fold opens to its own Raw (level 2 of the fold)", await q(p, () => { const r = document.querySelector(".spec:nth-of-type(6) .fold-rows .step[open]"); return !!r && !r.querySelector("[data-view='raw']").hidden; }));
check("becoming a fold keeps the open card's view as its first row", await q(p, () => { const f = document.querySelector(".spec:nth-of-type(7) .action[data-fold]"); return f.open && f.querySelector(".fold-rows .step").open && f.querySelector(":scope > summary").getBoundingClientRect().height === 40; }));
check("a bubble breaks a fold", await q(p, () => document.querySelectorAll(".spec:nth-of-type(8) .action").length === 2 && !document.querySelector(".spec:nth-of-type(8) [data-fold]")));
await p.close();

// The general card and tool servers ------------------------------------------------------------------
p = await open(gallery("general"));
const general = await words(p, ".spec:first-of-type .action");
check("the general card puts an opaque name in plain words", general[0].startsWith("Used skills search") && general[1].startsWith("Used get weather now") && general[2].startsWith("Used github publish"), JSON.stringify(general));
check("opened, it shows the gateway's own title as a row", await q(p, () => document.querySelector(".spec:nth-of-type(2) .action").innerText.includes("The gateway calls it")));
const server = await words(p, ".spec:nth-of-type(3) .action");
check("a tool-server call is the general card until its result names its server", server[0].startsWith("Using linear create issue") && server[1].startsWith("Used linear") && server[1].includes("create issue"), JSON.stringify(server));
await p.close();

// T3 Code ----------------------------------------------------------------------------------------------
p = await open(gallery("t3code"));
check(
  "a T3 Code call becomes the T3 Code card in the same place",
  await q(p, () => { const box = [...document.querySelectorAll(".spec")].find((s) => s.textContent.includes("becomes the T3 Code card")).querySelector(".spec-box"); return box.querySelector(".action").innerText.includes("t3code start thread") && box.querySelector(".messaged").innerText.includes("T3 Code") && box.querySelector(".messaged .state").textContent === "Call made"; }),
);
check("one thread, one card: follow-up and check join it in order", await q(p, () => { const c = [...document.querySelectorAll(".messaged[open]")].find((m) => m.textContent.includes("followed up")); const t = c.innerText; return t.indexOf("sent") < t.indexOf("followed up") && t.indexOf("followed up") < t.indexOf("Otto checked"); }));
check("Checking and Stop requested are states of the thread", await q(p, () => [...document.querySelectorAll(".messaged .state")].some((s) => s.textContent === "Checking") && [...document.querySelectorAll(".messaged .state")].some((s) => s.textContent === "Stop requested")));
check("later calls leave lines of their own that lead to the thread", await q(p, () => ["followup", "check", "stop"].every((l) => document.querySelector(`.messaged[data-line="${l}"] [data-action="show-thread"]`))));
await p.click('.messaged[data-line="check"] [data-action="show-thread"]');
check("Show the thread opens the thread's card and focuses it", await q(p, () => { const t = document.activeElement.closest(".messaged"); return !!t && !t.dataset.line && t.open; }));
check("listings fold, and never join a thread", (await words(p, ".action[data-kind='t3']"))[0].startsWith("Looked through T3 Code 2 times"));
await p.close();

// Reasoning and the run line ---------------------------------------------------------------------------
p = await open(gallery("reasoning"));
check("reasoning before a reply is one folded line; its text is not on screen", await q(p, () => { const t = document.querySelector(".spec:first-of-type .thought"); return !t.open && t.querySelector("summary").textContent.startsWith("Thought for 8s") && !t.querySelector(".thought-body").checkVisibility(); }));
check("opened, the reasoning shows, with Raw", await q(p, () => { const t = document.querySelector(".spec:nth-of-type(2) .thought"); return t.open && t.innerText.includes("insulation") && !!t.querySelector('[data-action="raw"]'); }));
const lines = await q(p, () => [...document.querySelectorAll(".spec:nth-of-type(4) .run-line summary")].map((s) => s.innerText.replace(/\s+/g, " ").trim()));
check("F-090 the run line, every ending", lines[0] === "Worked for 1m 12s · 14 actions" && lines[1] === "Worked for 1m 12s · 14 actions · 1 failed" && lines[2].startsWith("Stopped after 40s") && lines[3].startsWith("Failed after 12s"), JSON.stringify(lines));
check("opened, the run line is the run's record", await q(p, () => { const t = document.querySelector(".spec:nth-of-type(5) .run-line").innerText; return t.includes("scripted/dev-1") && t.includes("low effort requested") && t.includes("run_7f3a91c2") && !!document.querySelector(".spec:nth-of-type(5) .run-line [aria-label='Copy run id']"); }));
await p.close();

// The three test runs ---------------------------------------------------------------------------------------
for (const [name, cards, actions] of [["short", 2, 2], ["long", 16, 40], ["thought", 0, 0]]) {
  p = await open(scene(name, "&at=end"));
  const r = await q(p, () => ({
    cards: document.querySelectorAll("#transcript-inner > .card.action, #transcript-inner > .card.messaged").length,
    runLine: document.querySelector("#transcript-inner .run-line summary")?.innerText.replace(/\s+/g, " ").trim() || "",
    status: !!document.querySelector(".status-line"),
    opened: [...document.querySelectorAll("#transcript-inner details")].filter((d) => d.open).length,
    reasoning: document.querySelector("#transcript").innerText.includes("I know the general answer"),
    count: scenes.state.actions,
  }));
  check(`${name} run: ${cards} cards for ${actions} actions, nothing opened, no status line once it ended`, r.cards === cards && r.count === actions && !r.status && r.opened === 0 && !r.reasoning, JSON.stringify(r));
  if (actions) check(`${name} run: the run line counts ${actions} actions`, r.runLine.includes(`${actions} actions`), r.runLine);
  else check("thought run: no run line, one Thought line over the reply", !r.runLine && (await q(p, () => document.querySelector("#transcript-inner .thought[data-place='reply'] + .msg") !== null)));
  if (name === "long") {
    check("long run stays calm: every card is one 40 px line, three columns between bubbles", await q(p, () => [...document.querySelectorAll("#transcript-inner .card > summary")].every((s) => Math.round(s.getBoundingClientRect().height) === 40) && [...document.querySelectorAll("#transcript-inner > .msg + .card")].length === 3));
    check("long run: the one failure is named on its line", await q(p, () => [...document.querySelectorAll("#transcript-inner .action[data-fold]")].filter((c) => c.querySelector(".action-detail[data-tone='danger']")).length === 1));
  }
  await p.close();
}

// While it runs: a new action joins an open fold ------------------------------------------------------------
p = await open(scene("long"));
await q(p, () => { scenes.replay(); });
await q(p, () => scenes.runTo(9));
const live = await q(p, () => { const f = document.querySelector("#transcript-inner .action[data-kind='read'][data-fold]"); f.open = true; f.querySelector(".fold-rows .step").open = true; const top = f.getBoundingClientRect().top; scenes.runTo(10); const g = document.querySelector("#transcript-inner .action[data-kind='read'][data-fold]"); return [g.open, g.querySelectorAll(".fold-rows .step").length, g.querySelector(".fold-rows .step").open, g.querySelector(":scope > summary").innerText.replace(/\s+/g, " ").includes("3 files"), Math.round(g.getBoundingClientRect().top - top)]; });
check("a new action while a fold is open is a new row; open rows stay open; nothing above moves", live[0] && live[1] === 3 && live[2] && live[3] && live[4] === 0, JSON.stringify(live));
check("the status line says the running card's words", await q(p, () => { const phrase = document.querySelector(".status-phrase").textContent; const f = document.querySelector("#transcript-inner .action[data-kind='read'][data-fold]"); return phrase === "Reading epc-2019.pdf" && f.querySelector(".action-detail").textContent === "reading epc-2019.pdf"; }));
await p.close();

// The scripted run -----------------------------------------------------------------------------------------
p = await open(run);
await q(p, () => demo.runTo("first-step"));
check("as an action starts, its card and the status line say the same words", await q(p, () => document.querySelector("#s-read > summary").innerText.includes("Reading") && document.querySelector(".status-phrase").textContent === "Reading backup-2026-11-15.log"));
await q(p, () => demo.disconnect());
await p.waitForTimeout(120);
check("B4 a running card is last seen while the connection is lost, and still", await q(p, () => document.querySelector("#s-read .action-state").textContent === "Last seen running" && document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest("#s-read")).length === 0));
await q(p, () => demo.reconnect());
await p.waitForTimeout(900);
await q(p, () => demo.runTo("second-read"));
check("a card that was open becomes a fold with its row open", await q(p, () => { const f = document.querySelector("#fold-s-read"); return !!f && f.open && document.querySelector("#s-read").open && f.querySelector(":scope > summary").innerText.replace(/\s+/g, " ").startsWith("Read 2 files"); }));
await q(p, () => demo.runTo("read-failed"));
check("a failure in the fold is on its line", await q(p, () => { const t = document.querySelector("#fold-s-read > summary").innerText.replace(/\s+/g, " "); return t.includes("1 failed") && t.includes("couldn't read backup-2026-11-08.log"); }));
check("the reasoning before the failed read sits in its row, folded", await q(p, () => { const t = document.querySelector("#s-read2 .action-thought .thought"); return !!t && !t.open; }));
await q(p, () => demo.runTo("list"));
await p.click(".status-line");
check("the status line brings the running card into view and focuses it, without opening it", await q(p, () => document.activeElement.closest("#s-list") && !document.querySelector("#s-list").open));
await q(p, () => demo.runTo("approval"));
check("an approval ends the column: the waiting card, then the approval card", await q(p, () => document.querySelector("#s-exec").dataset.status === "waiting" && document.querySelector("#s-exec").nextElementSibling.id === "approval"));
await q(p, () => { demo.answer("once"); });
await p.waitForTimeout(50);
await q(p, () => demo.runTo("question"));
await p.click('#question .option[data-letter="A"]');
await q(p, () => demo.runTo("finished"));
await p.waitForTimeout(300);
check("F-090 the run line follows the run and counts its actions and its failure", await q(p, () => { const l = [...document.querySelectorAll("#transcript-inner .run-line")].at(-1).innerText.replace(/\s+/g, " "); return /Worked for .* · \d+ actions · 1 failed/.test(l) && !document.querySelector(".status-line"); }));
check("nothing folds by itself when the run ends", await q(p, () => document.querySelector("#fold-s-read").open));
await p.close();

p = await open(run + "&tier=read");
await q(p, () => demo.runTo("approval"));
check("read-only: the same cards, and the waiting card says Waiting for approval", await q(p, () => document.querySelector("#s-exec .action-state").textContent === "Waiting for approval" && !!document.querySelector("#fold-s-read")));
await p.close();

// Phone width -------------------------------------------------------------------------------------------------
p = await open(scene("long", "&at=end&width=phone"), { w: 390, h: 844 });
check("phone: the detail moves to a second line and is never dropped", await q(p, () => [...document.querySelectorAll("#transcript-inner .action > summary")].every((s) => { const d = s.querySelector(".action-detail"); return !d.textContent || (d.checkVisibility() && d.getBoundingClientRect().top > s.querySelector(".action-verb").getBoundingClientRect().bottom - 2); })));
check("phone: no card is wider than the column", await q(p, () => { const t = document.querySelector("#transcript-inner").getBoundingClientRect(); return [...document.querySelectorAll("#transcript-inner .card")].every((c) => c.getBoundingClientRect().right <= t.right + 0.5); }));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("ok")).length} ok, ${out.filter((l) => !l.startsWith("ok")).length} not ok`);
if (out.some((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR"))) process.exit(1);
