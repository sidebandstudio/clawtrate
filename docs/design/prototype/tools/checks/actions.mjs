// Behaviour checks for the action cards (conversation.md, sections 7, 8 and 11):
// the gallery's sections, the four scenes, and the scripted run.
// Run from the repository root:  node docs/design/prototype/tools/checks/actions.mjs
import { chromium, pageUrl } from "./browser.mjs";

const gallery = (section, extra = "") => pageUrl(`gallery.html?chrome=0&theme=light&section=${section}${extra}`);
const scene = (name, extra = "") => pageUrl(`conversation.html?chrome=0&theme=light&scene=${name}${extra}`);
const run = pageUrl("conversation.html?chrome=0&theme=light");
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name} ${ok ? "" : extra}`);

async function open(url, { w = 1440, h = 900, touch = false } = {}) {
  const ctx = await b.newContext({ viewport: { width: w, height: h }, hasTouch: touch });
  const p = await ctx.newPage();
  p.on("pageerror", (e) => out.push("PAGEERROR " + String(e.stack || e).split("\n").slice(0, 2).join(" | ")));
  await p.goto(url);
  await p.evaluate(() => document.fonts.ready);
  await p.evaluate(() => {
    // A specimen's box, by the specimen's name.
    window.box = (name) => [...document.querySelectorAll(".spec")].find((s) => s.querySelector("h3").textContent === name)?.querySelector(".spec-box");
    window.S = CT.samples;
    window.line = (el) => el.querySelector(":scope > summary").innerText.replace(/\s+/g, " ").trim();
  });
  await p.waitForTimeout(100);
  return p;
}
const q = (p, fn, arg) => p.evaluate(fn, arg);
const lines = (p, name, sel = ":scope > details.card") => q(p, ([n, s]) => [...box(n).querySelectorAll(s)].map(line), [name, sel]);
const spec = (p, name) => p.locator(".spec", { has: p.locator("h3", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).locator(".spec-box");

// Every kind, in order, with nothing opened (F-488) -------------------------------------------
let p = await open(gallery("actions"));
const first = await lines(p, "Every kind, done");
const expected = [
  "Read backup-2026-11-15.log",
  "Looked in archive",
  "Edited house-log.md",
  "Saved to memory",
  'Searched memory for "boiler service"',
  "Ran du",
  "Looked at shared terminals",
  'Searched the web for "cold climate heat pump performance"',
  'Searched posts on X for "heat pump rebate 2026 experiences"',
  "Opened energy.example.org",
  'Clicked "Add to basket"',
  "Clicked on the screen",
  "Tapped on the phone",
  "Changed the Control UI",
  "Created routine Weekly cleanup",
  "Messaged Marlow",
  "Looked through tasks",
  "Started a helper: Price check",
  "Asked you a question",
  "Made a plan",
  "Made 2 images",
  "Read 3 PDFs",
  "Message on Telegram",
  "Used linear",
  "Messaged T3 Code",
  "Used skills search",
];
check("F-488 every kind shows its label, in order", expected.length === first.length && expected.every((label, i) => first[i].startsWith(label)), JSON.stringify(first.map((f, i) => [expected[i], f])));
check("F-488 nothing is opened and no Raw is on screen", await q(p, () => ![...box("Every kind, done").querySelectorAll("details")].some((d) => d.open) && [...box("Every kind, done").querySelectorAll("[role='tabpanel']")].every((t) => !t.checkVisibility())));
check(
  "F-430 a closed card has a verb, an icon, an object, a detail slot and a state",
  await q(p, () => [...box("Every kind, done").querySelectorAll(".action")].every((c) => c.querySelector(".action-verb").textContent && c.querySelector(".action-what > .icon, .action-what > .agent-mark") && c.querySelector(".action-detail") && c.querySelector(".action-state"))),
);
check("one line, 40 px, at desktop width", await q(p, () => [...box("Every kind, done").querySelectorAll(".action > summary")].every((s) => Math.round(s.getBoundingClientRect().height) === 40)));
check(
  "cards in a row form a column: 2 px apart, 6 px touching corners",
  await q(p, () => {
    const [a, c] = box("Every kind, done").querySelectorAll(".action");
    const gap = Math.round(c.getBoundingClientRect().top - a.getBoundingClientRect().bottom);
    return gap === 2 && getComputedStyle(a).borderTopLeftRadius === "18px" && getComputedStyle(a).borderBottomLeftRadius === "6px" && getComputedStyle(c).borderTopLeftRadius === "6px";
  }),
);
const running = await lines(p, "Every kind, while it runs");
check(
  "M1 running: the present tense where the action stays on the gateway, Call started where it leaves",
  running[0].startsWith("Reading") && running.some((l) => l.startsWith("Helper") && l.endsWith("Call started")) && running.some((l) => l.startsWith("Image") && l.endsWith("Call started")) && running.some((l) => l.startsWith("Message on") && l.endsWith("Call started")) && !running.some((l) => /\bSending\b/.test(l)),
  JSON.stringify(running),
);
check("a failed card says Couldn't and Failed", await q(p, () => [...box("Every kind, when it failed").querySelectorAll(".action")].every((c) => c.querySelector(".action-verb").textContent.startsWith("Couldn't") && c.querySelector(".state[data-tone='danger']"))));
const notDone = await lines(p, "A result is not always completed work");
check(
  "M1 a result is read by the kind's adapter: admitted, queued, suppressed, unavailable work never reads as done",
  [
    ["Started making an image", "Started"],
    ["Made 2 images", ""],
    ["Started a helper: Price check", "Started"],
    ["Asked routine Weekly cleanup to run", "Queued"],
    ["Message on Telegram", "Queued"],
    ["Message on Telegram", "Sent"],
    ["Didn't send a message on Telegram", "Suppressed"],
    ["Message on Telegram", "Call made"],
    ["Clicked on the screen", "Not confirmed"],
    ['Searched memory for "gutters"', "Partial"],
    ['Couldn\'t search memory for "loft insulation"', "Unavailable"],
    ['Couldn\'t search posts on X for', "Unavailable"],
  ].every(([start, end], i) => notDone[i]?.startsWith(start) && notDone[i].endsWith(end)) && !notDone.some((l) => /^Made an image|^Ran routine|Sent$/.test(l) && !/^Made 2/.test(l) && !l.endsWith("Sent")),
  JSON.stringify(notDone),
);
const states = await lines(p, "One card in every state");
check(
  "one card in every state, in words the gateway can establish",
  ["Running mv", "Reviewing mv", "Wants to run mv", "Ran du", "Ran grep", "Couldn't run mv", "Timed out: rsync", "Didn't run mv", "Blocked by policy", "Blocked by review", "Stopped running mv", "Message on Telegram", "Message on Telegram"].every((label, i) => states[i]?.startsWith(label)) &&
    states[4].includes("exit 1") && states[7].endsWith("Denied") && states[11].endsWith("Unknown") && states[12].endsWith("Call started"),
  JSON.stringify(states),
);
check("a non-zero exit code is plain text, not a failure", await q(p, () => { const c = box("One card in every state").querySelectorAll(".action")[4]; return c.dataset.status === "done" && getComputedStyle(c.querySelector(".action-exit")).color === getComputedStyle(document.body).color; }));
const ops = await lines(p, "Real operations, with their own words");
check(
  "M2 real operations: terminal, screen, phone, documents, a patch's files, goals, routines, speech",
  ["Looked at shared terminals", "Typed into a terminal", "Changed the Control UI", "Looked at the phone", "Tapped on the phone", "Read 3 PDFs", "Looked at 2 images", "Edited 3 files", "Checked the goal", "Marked the goal complete", "Removed routine Old reminder", "Made a voice clip"].every((label, i) => ops[i]?.startsWith(label)) && !ops.some((l) => l.startsWith("Ran ")),
  JSON.stringify(ops),
);
check("M2 a plan's steps are completed, in progress or pending", await q(p, () => { const items = [...box("Kinds opened").querySelectorAll(".action-plan li")]; return items.map((i) => i.dataset.status).join(",") === "completed,completed,in_progress,pending" && items[0].querySelector(".glyph[data-state='check']") && items[2].querySelector(".glyph[data-state='working']"); }));
check("M2 a routine's schedule names its time zone", (await lines(p, "Every kind, done")).find((l) => l.startsWith("Created routine")).includes("Mondays at 9:00 AM, Europe/London"));
check("last seen: nothing that stands for work moves", await q(p, () => document.getAnimations().filter((a) => a.playState === "running" && a.effect?.target?.closest("[data-connection='lost']")).length === 0 && document.querySelectorAll("[data-connection='lost'] .state").length === 2));
check("text beside a tool call is a bubble that ends the column", await q(p, () => [...box("Text beside a tool call").children].map((c) => c.className.split(" ")[0]).join(",") === "msg,card,card,msg,card"));

// Levels: open a card, Raw is one step further ----------------------------------------------------
check("level 1: an opened card shows its readable view", await q(p, () => { const c = box("Opened: the readable view").querySelector(".action"); return c.open && c.querySelector("[role=tab][aria-selected=true]").textContent === "Readable" && !!c.querySelector("[data-view='readable'] .code-block"); }));
check("level 2: Raw holds the tool, arguments, result, timing and ids", await q(p, () => { const raw = box("Opened: Raw, one step further").querySelector("[data-view='raw']"); const t = raw.textContent; return !raw.hidden && ["Tool", "Arguments", "Result", "Timing", "Identifiers"].every((w) => t.includes(w)) && raw.querySelector(".tool-name").textContent === "read"; }));
check("level 2: the reasoning that led to an action is inside its card, under a Thought line", await q(p, () => { const t = box("Opened: the reasoning that led to it").querySelector(".action-thought .thought"); return !!t && t.querySelector("summary").textContent.startsWith("Thought for 4s") && t.textContent.includes("71 minutes"); }));
await spec(p, "Opened: the readable view").locator("[data-view-button='raw']").first().click();
check("the Raw tab switches the view in place", await q(p, () => !box("Opened: the readable view").querySelector("[data-view='raw']").hidden));
check("read-only: a call waiting for approval says so, and the question is a card", await q(p, () => { const t = box("On a read-only connection").innerText.replace(/\s+/g, " "); return t.includes("Waiting for approval") && t.includes("Asking you a question") && t.includes("Request access"); }));
await p.close();

// M6: the phone keeps the object readable in every state ----------------------------------------------
p = await open(gallery("actions", "&width=phone"), { w: 390, h: 844, touch: true });
const phone = await q(p, () =>
  ["Every kind, when it failed", "Every kind, while it runs", "A result is not always completed work", "One card in every state"].flatMap((n) =>
    [...box(n).querySelectorAll(".action")].map((c) => {
      const o = c.querySelector(".action-object");
      const s = c.querySelector(".action-sentence");
      const lineH = parseFloat(getComputedStyle(s).lineHeight);
      return { n, line: line(c), objectWidth: o ? o.getBoundingClientRect().width : -1, objectChars: o ? o.textContent.length : 0, sentenceLines: Math.round(s.getBoundingClientRect().height / lineH), right: c.getBoundingClientRect().right <= c.parentElement.getBoundingClientRect().right + 0.5 };
    }),
  ),
);
const cramped = phone.filter((r) => r.objectWidth !== -1 && r.objectChars > 0 && (r.objectWidth < Math.min(r.objectChars * 6, 60) || r.sentenceLines > 2 || !r.right));
check("M6 phone: in every state, what an action acted on is readable, in at most two lines", phone.length > 40 && cramped.length === 0, JSON.stringify(cramped.slice(0, 4)));
check("M6 phone: the long failed X search keeps its query on screen", phone.some((r) => r.line.startsWith('Couldn\'t search posts on X for "heat pump rebate') && r.objectWidth > 100));
check("phone: the state word is never shortened", await q(p, () => [...document.querySelectorAll(".action .action-state .state")].every((s) => s.scrollWidth <= s.clientWidth + 1)));
await p.close();

// Folds (M3) -----------------------------------------------------------------------------------------
p = await open(gallery("folds"));
const folds = await lines(p, "Done", ":scope > .action");
check("F-488 a run of six reads is one card", folds[0].startsWith("Read 6 files"), folds[0]);
check(
  "folds read as one line with a count, true of every member",
  ["Searched the web 3 times", "Edited 5 files", "Used the browser 4 actions", "Searched memory 2 times", "Saved the plan 3 times", "Looked through T3 Code 2 times"].every((label, i) => folds[i + 1].replace(" · ", " ").startsWith(label)),
  JSON.stringify(folds),
);
const counting = await lines(p, "Counting files and actions", ":scope > .action");
check("M3 files are counted once, and the actions too when there are more", counting[0].startsWith("Read 2 files · 3 reads") && counting[1].startsWith("Edited 2 files · 3 edits"), JSON.stringify(counting));
check("a fold with an action running names it", (await lines(p, "One action running", ":scope > .action"))[0].includes("reading"));
const failed = await q(p, () => { const c = box("A failure inside a fold").querySelector(".action"); return [c.open, c.querySelector(".action-detail").textContent, c.querySelector(".action-state").textContent, c.querySelector(".action-detail").dataset.tone]; });
check("F-092 a failure inside a closed fold is named on its line", !failed[0] && failed[1].includes("couldn't read backup-2026-11-08.log") && failed[2].includes("1 failed") && failed[3] === "danger", JSON.stringify(failed));
const mixed = await lines(p, "Mixed states: an earlier failure and a later approval", ":scope > .action");
check(
  "M3 mixed states: the failure in the detail, what is happening now at the right",
  mixed[0].includes("1 failed: couldn't run mv") && mixed[0].endsWith("Waiting for you") && mixed[1].includes("1 failed: couldn't read backup-2026-11-08.log") && (await q(p, () => box("Mixed states: an earlier failure and a later approval").querySelectorAll(".action")[1].querySelector(".action-elapsed")?.textContent === "0:04")),
  JSON.stringify(mixed),
);
const other = await lines(p, "Stopped, unavailable, and a missing time", ":scope > .action");
check("M3 stopped and unavailable members are named; a missing time gives no partial sum", other[0].endsWith("2 stopped") && other[0].includes("stopped reading") && other[1].endsWith("1 unavailable") && !/\d+(\.\d)?s$/.test(other[2]), JSON.stringify(other));
check("level 1 of a fold: one row per action, in the singular", await q(p, () => { const rows = [...box("Opened").querySelectorAll(".fold-rows .step")]; return rows.length === 3 && rows[1].dataset.status === "failed" && rows[0].querySelector(".step-title").textContent.startsWith("Read ") && rows.every((r) => r.querySelector("[role=tab]")); }));
check("a row in a fold opens to its own Raw (level 2 of the fold)", await q(p, () => { const r = box("Opened, with one row opened on Raw").querySelector(".fold-rows .step[open]"); return !!r && !r.querySelector("[data-view='raw']").hidden; }));
check("becoming a fold keeps the open card's view as its first row", await q(p, () => { const f = box("Becoming a fold").querySelector(".action[data-fold]"); return f.open && f.querySelector(".fold-rows .step").open && f.querySelector(":scope > summary").getBoundingClientRect().height === 40; }));
check("a bubble breaks a fold", await q(p, () => box("What breaks a fold").querySelectorAll(".action").length === 2 && !box("What breaks a fold").querySelector("[data-fold]")));
check(
  "M3 the engine: an opaque name not known to the inventory never folds; a known one does",
  await q(p, () => {
    const host = document.createElement("div");
    document.body.append(host);
    const insert = (html) => (host.insertAdjacentHTML("beforeend", html), host.lastElementChild);
    const feed = CT.feed({ insert, instant: () => true });
    feed.start({ id: "u1", name: "linearCreateIssue", args: {} });
    feed.start({ id: "u2", name: "linearCreateIssue", args: {} });
    feed.start({ id: "k1", name: "skills_search", args: { query: "a" }, builtin: true });
    feed.start({ id: "k2", name: "skills_search", args: { query: "b" }, builtin: true });
    const kinds = [...host.children].map((c) => c.dataset.fold || "1").join(",");
    host.remove();
    return kinds === "1,1,2";
  }),
);
await p.close();

// The general card and tool servers ------------------------------------------------------------------
p = await open(gallery("general"));
const general = await lines(p, "Opaque names, in plain words", ":scope > .action");
check("the general card puts an opaque name in plain words", general[0].startsWith("Used skills search") && general[1].startsWith("Used get weather now") && general[2].startsWith("Used github publish"), JSON.stringify(general));
check("opened, it shows the gateway's own title as a row", await q(p, () => box("Opened").querySelector(".action").innerText.includes("The gateway calls it")));
const server = await lines(p, "A tool-server call, before and after its result", ":scope > .action");
check("a tool-server call is the general card until its result names its server", server[0].startsWith("Using linear create issue") && server[1].startsWith("Used linear") && server[1].includes("create issue"), JSON.stringify(server));
await p.close();

// T3 Code (M4, M5) ------------------------------------------------------------------------------------
p = await open(gallery("t3code"));
check(
  "M4 a call is T3 Code's by its result naming one of the seven tools, whatever the server is called",
  await q(p, () => {
    const k = (mcp) => CT.kindOf({ id: "x", name: "anything", args: {}, status: "done", mcp }).kind;
    return k({ server: "t3code", tool: "t3_thread_launch" }) === "t3" && k({ server: "work-coder", tool: "t3_thread_send" }) === "t3" && k({ server: "t3code", tool: "orchestrator_capabilities" }) === "server" && k({ server: "t3code", tool: "t3_project_list" }) === "t3list";
  }),
);
check(
  "M4 a thread is keyed by server, environment and thread id, read from structured content or its rendering",
  await q(p, () => {
    const a = CT.threadKey(S.calls.t3Launch);
    const fromHistory = CT.threadKey({ ...S.calls.t3Launch, details: undefined });
    const other = CT.threadKey({ ...S.calls.t3Send, mcp: { server: "work-coder", tool: "t3_thread_send" } });
    const env = CT.threadKey({ ...S.calls.t3Send, args: { ...S.calls.t3Send.args, environmentId: "env-2" } });
    return a === fromHistory && a === CT.threadKey(S.calls.t3Send) && a !== other && a !== env;
  }),
);
check("M5 every call on a thread has its own item and its own Raw", await q(p, () => { const card = box("One thread, one card: every call on it, each with its own Raw").querySelector(".messaged"); const items = [...card.querySelectorAll(".t3-item")]; return items.length === 6 && items.every((i) => i.querySelector('[aria-label="Raw for this call"]')); }));
const tools = await q(p, async () => {
  const card = box("One thread, one card: every call on it, each with its own Raw").querySelector(".messaged");
  card.open = true;
  const seen = [];
  for (const item of card.querySelectorAll(".t3-item")) {
    const btn = item.querySelector('[aria-label="Raw for this call"]');
    if (btn.getAttribute("aria-expanded") !== "true") btn.click();
    const panel = document.getElementById(btn.getAttribute("aria-controls"));
    seen.push([!panel.hidden, panel.querySelector(".tool-name")?.textContent, panel.textContent.includes(item.dataset.call)]);
  }
  return seen;
});
check("M5 each joined call's Raw opens to that call: its own tool and its own id", tools.length === 6 && tools.every(([shown, , own]) => shown && own) && new Set(tools.map(([, t]) => t)).size === 5, JSON.stringify(tools));
const threadStates = await lines(p, "The thread's state, from its calls", ":scope > .messaged");
check(
  "M5 the thread's state: an open call, then what T3 Code reported, never changed by a failed read",
  ["Call started", "Checking", "Running", "Running", "Completed", "Stop requested"].every((w, i) => threadStates[i]?.endsWith(w)),
  JSON.stringify(threadStates),
);
await spec(p, "Later calls leave a line where they happened").locator('.messaged[data-line="read"] [data-action="show-thread"]').click();
check("M5 Show the thread finds the card by identity, opens the call's item and focuses it", await q(p, () => { const a = document.activeElement; const card = a.closest(".messaged"); return !!card && !card.dataset.line && card.open && a.closest(".t3-item")?.dataset.call === S.calls.t3Read.id; }));
await spec(p, "Later calls leave a line where they happened").locator('.t3-item[data-call="' + "call_01HXM2A" + '"] [data-action="show-where"]').click();
check("M5 Show where it happened goes back to the call's own line", await q(p, () => document.activeElement.closest(".messaged")?.dataset.line === "send"));
check("listings fold, and never join a thread", (await lines(p, "Listing projects and threads", ":scope > .action"))[0].startsWith("Looked through T3 Code 2 times"));
await p.close();

// M5 live: the change in place, joining, lines and Raw, in the T3 scene ----------------------------------
p = await open(scene("t3"));
await q(p, () => { scenes.reset(); scenes.runTo(2); });
const before = await q(p, async () => {
  const card = document.querySelector("#transcript-inner .action");
  card.open = true;
  card.querySelector('[data-view-button="raw"]').click();
  card.querySelector('[aria-label="Copy tool name"]').focus();
  return [card.id, card.offsetTop, line(card)];
});
await q(p, () => scenes.runTo(3));
const after = await q(p, () => {
  const card = document.querySelector("#transcript-inner .messaged[data-thread]");
  const item = card.querySelector(`.t3-item[data-call="${S.calls.t3Launch.id}"]`);
  const raw = item.querySelector('[aria-label="Raw for this call"]');
  return [card.offsetTop, line(card), card.open, raw.getAttribute("aria-expanded"), document.activeElement.getAttribute("aria-label"), Boolean(item.contains(document.activeElement))];
});
check(
  "M5 a launch known only by its result becomes the T3 Code card in place, open, with its Raw open and focus on the same control",
  before[2].startsWith("Using t3code t3 thread launch") && after[1].startsWith("Messaged T3 Code") && after[0] === before[1] && after[2] && after[3] === "true" && after[4] === "Copy tool name" && after[5],
  JSON.stringify({ before, after }),
);
await q(p, () => scenes.runTo(5));
await p.waitForTimeout(450);
check("M5 a wait right after the card joins it directly: no line of its own, an item with its Raw", await q(p, () => !document.querySelector(`#transcript-inner [data-line][data-call="${S.calls.t3Wait.id}"]`) && !!document.querySelector(`#transcript-inner .messaged[data-thread] .t3-item[data-call="${S.calls.t3Wait.id}"] [aria-label="Raw for this call"]`)));
await q(p, () => scenes.runTo("end"));
await p.waitForTimeout(450);
const t3end = await q(p, () => {
  const card = document.querySelector("#transcript-inner .messaged[data-thread]");
  return {
    items: [...card.querySelectorAll(".t3-item")].map((i) => i.dataset.call),
    lines: [...document.querySelectorAll("#transcript-inner .messaged[data-line]")].map((l) => l.dataset.line),
    state: line(card),
    failedItem: card.querySelector(`.t3-item[data-call="${S.calls.t3ReadFail.id}"] .state`)?.textContent,
    runLine: document.querySelector("#transcript-inner .run-line summary").innerText.replace(/\s+/g, " "),
  };
});
check(
  "M5 later calls keep lines; every call is an item; the failed read is on its item, and the thread says Stop requested",
  t3end.items.length === 6 && t3end.lines.join(",") === "send,read,read,interrupt" && t3end.failedItem === "Failed" && t3end.state.endsWith("Stop requested") && t3end.runLine.includes("7 actions"),
  JSON.stringify(t3end),
);
check(
  "M5 a call the name mapping called T3 Code's, whose result names another tool, becomes that tool's card in place",
  await q(p, () => {
    const host = document.createElement("div");
    document.body.append(host);
    const feed = CT.feed({ insert: (html) => (host.insertAdjacentHTML("beforeend", html), host.lastElementChild), instant: () => true });
    feed.start({ id: "o1", name: "t3code__t3_thread_send", args: { threadId: "mcp:x" }, nameMap: { server: "t3code", tool: "t3_thread_send" } });
    const was = host.firstElementChild.classList.contains("messaged");
    feed.update("o1", { status: "done", mcp: { server: "t3code", tool: "create_issue" }, details: { mcpServer: "t3code", mcpTool: "create_issue" }, text: "ok" });
    const now = host.firstElementChild;
    const ok = was && now.classList.contains("action") && line(now).startsWith("Used t3code") && host.children.length === 1;
    host.remove();
    return ok;
  }),
);
await p.close();

// Reasoning and the run line ---------------------------------------------------------------------------
p = await open(gallery("reasoning"));
check("reasoning before a reply is one folded line; its text is not on screen", await q(p, () => { const t = box("Reasoning that led to the reply").querySelector(".thought"); return !t.open && t.querySelector("summary").textContent.startsWith("Thought for 8s") && !t.querySelector(".thought-body").checkVisibility(); }));
check("opened, the reasoning shows, with Raw", await q(p, () => { const t = box("Opened").querySelector(".thought"); return t.open && t.innerText.includes("insulation") && !!t.querySelector('[data-action="raw"]'); }));
const runLines = await q(p, () => [...box("The run line, every ending").querySelectorAll(".run-line summary")].map((s) => s.innerText.replace(/\s+/g, " ").trim()));
check("F-090 the run line, every ending", runLines[0] === "Worked for 1m 12s · 14 actions" && runLines[1] === "Worked for 1m 12s · 14 actions · 1 failed" && runLines[2].startsWith("Stopped after 40s") && runLines[3].startsWith("Failed after 12s"), JSON.stringify(runLines));
check("opened, the run line is the run's record", await q(p, () => { const t = box("The run line, opened").querySelector(".run-line").innerText; return t.includes("scripted/dev-1") && t.includes("low effort requested") && t.includes("run_7f3a91c2") && !!box("The run line, opened").querySelector("[aria-label='Copy run id']"); }));
await p.close();

// The test runs ---------------------------------------------------------------------------------------
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

// While it runs: a new action joins an open fold; focus and Thought survive -------------------------------
p = await open(scene("long"));
await q(p, () => { scenes.reset(); scenes.runTo(9); });
const live = await q(p, () => {
  const f = document.querySelector("#transcript-inner .action[data-kind='read'][data-fold]");
  f.open = true;
  const row = f.querySelector(".fold-rows .step");
  row.open = true;
  row.querySelector('[data-view-button="raw"]').click();
  row.querySelector('[data-view-button="raw"]').focus();
  const top = f.offsetTop;
  scenes.runTo(10);
  const g = document.querySelector("#transcript-inner .action[data-kind='read'][data-fold]");
  const r = g.querySelector(".fold-rows .step");
  return [g.open, g.querySelectorAll(".fold-rows .step").length, r.open, line(g).includes("3 files"), g.offsetTop - top, document.activeElement.dataset.viewButton, r.contains(document.activeElement), !r.querySelector("[data-view='raw']").hidden];
});
check("a new action while a fold is open is a new row; open rows stay open in their view; focus stays on the same control; nothing above moves", live[0] && live[1] === 3 && live[2] && live[3] && live[4] === 0 && live[5] === "raw" && live[6] && live[7], JSON.stringify(live));
check("the status line says the running card's words", await q(p, () => document.querySelector(".status-phrase").textContent === "Reading epc-2019.pdf" && line(document.querySelector("#transcript-inner .action[data-kind='read'][data-fold]")).includes("reading epc-2019.pdf")));
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
check("a card that was open becomes a fold with its row open", await q(p, () => { const f = document.querySelector("#fold-s-read"); return !!f && f.open && document.querySelector("#s-read").open && line(f).startsWith("Read 2 files"); }));
await q(p, () => { const t = document.querySelector("#s-read2 .action-thought .thought"); t.open = true; });
await q(p, () => demo.runTo("read-failed"));
check("a failure in the fold is on its line", await q(p, () => { const t = line(document.querySelector("#fold-s-read")); return t.includes("1 failed") && t.includes("couldn't read backup-2026-11-08.log"); }));
check("an open Thought line stays open through an ordinary update", await q(p, () => document.querySelector("#s-read2 .action-thought .thought").open));
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
p = await open(scene("long", "&at=end&width=phone"), { w: 390, h: 844, touch: true });
check("phone: the detail moves to a last line and is never dropped", await q(p, () => [...document.querySelectorAll("#transcript-inner .action > summary")].every((s) => { const d = s.querySelector(".action-detail"); return !d.textContent || (d.checkVisibility() && d.getBoundingClientRect().top >= s.querySelector(".action-sentence").getBoundingClientRect().bottom - 2); })));
check("phone: no card is wider than the column", await q(p, () => { const t = document.querySelector("#transcript-inner").getBoundingClientRect(); return [...document.querySelectorAll("#transcript-inner .card")].every((c) => c.getBoundingClientRect().right <= t.right + 0.5); }));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("ok")).length} ok, ${out.filter((l) => !l.startsWith("ok")).length} not ok`);
if (out.some((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR"))) process.exit(1);
