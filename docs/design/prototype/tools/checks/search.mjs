// Behaviour checks for search.html (docs/design/search.md): opening the palette,
// what each source covers and how an incomplete answer is said, dropping work
// from an earlier query or connection (on a fake clock), message coverage from
// the reply, opening by the returned ids, files and their workspace, the link
// handoff and its confirmation, the phone and the iPhone, Settings and routines.
// Run from the repository root:  node docs/design/prototype/tools/checks/search.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("search.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
let failed = 0;
const check = (name, ok, extra = "") => {
  if (!ok) failed += 1;
  out.push(`${ok ? "ok  " : "FAIL"} ${name}${ok || !extra ? "" : ` (${extra})`}`);
};
const open = async (query = "", viewport = { width: 1440, height: 900 }, { clock = false } = {}) => {
  const p = await b.newPage({ viewport });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  if (clock) await p.clock.install({ time: new Date("2026-11-18T22:00:00Z") });
  await p.goto(base + (query ? "&" + query : ""));
  if (clock) await p.clock.runFor(50);
  else await p.waitForTimeout(150);
  return p;
};
const settle = (p) => p.waitForTimeout(900);
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.innerText || "", sel);
const body = (p) => text(p, "#s-body");
const live = (p) => p.evaluate(() => document.querySelector("#s-live")?.textContent || "");
const paletteOpen = (p) => p.evaluate(() => !document.querySelector("#search-layer").hidden && Boolean(document.querySelector('.s-palette[role="dialog"]')));
const groupText = (p, id) => text(p, `.s-group[data-group="${id}"]`);
const activeText = (p) => p.evaluate(() => document.getElementById(document.querySelector("#s-field")?.getAttribute("aria-activedescendant"))?.innerText || "");
const requests = (p, source) => p.evaluate((s) => CT.searchTest.requests.filter((r) => !s || r.source === s), source);
const handoffs = (p) => p.evaluate(() => CT.searchTest.handoffs);
const type = async (p, q) => {
  await p.fill("#s-field", q);
  await settle(p);
};
const activate = async (p, label) => {
  for (let i = 0; i < 90; i++) {
    if ((await activeText(p)).includes(label)) return;
    await p.keyboard.press("ArrowDown");
  }
  throw new Error(`no option with "${label}"`);
};
// Records every text the live region takes, to show what was never said.
const recordLive = (p) =>
  p.evaluate(() => {
    window.__said = [];
    new MutationObserver(() => window.__said.push(document.querySelector("#s-live").textContent)).observe(document.querySelector("#s-live"), { childList: true, characterData: true, subtree: true });
  });
const said = (p) => p.evaluate(() => window.__said.filter(Boolean));

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Opening, before anything is typed, closing ---------------------------------------------------------------
let p = await open("platform=mac");
const button = p.locator('[data-action="search"]');
check("F-033 the rail's button is named Search, opens a dialog, and its tooltip names ⌘K on the Mac", (await button.getAttribute("aria-label")) === "Search" && (await button.getAttribute("aria-haspopup")) === "dialog" && (await button.getAttribute("title")) === "Search (⌘K)");
await p.locator(".composer-input").focus().catch(() => {});
await p.keyboard.press("Meta+k");
await p.waitForTimeout(120);
check("F-033 ⌘K opens the palette from the composer, focus in its field", (await paletteOpen(p)) && (await p.evaluate(() => document.activeElement.id === "s-field")));
check("S3 a modal dialog named Search; its field is a combobox named Search for the result list", await p.evaluate(() => { const d = document.querySelector(".s-palette"); const f = document.querySelector("#s-field"); return d.getAttribute("aria-modal") === "true" && d.getAttribute("aria-label") === "Search" && f.getAttribute("role") === "combobox" && f.getAttribute("aria-label") === "Search" && f.getAttribute("aria-controls") === "s-list"; }));
check("R7 the background is inert while search is open", await p.evaluate(() => document.querySelector(".shell").inert === true));
const idle = await body(p);
check(
  "S4 before typing, what each source covers",
  idle.includes("What search looks in") &&
    idle.includes("Every bot this connection can see, by name.") &&
    idle.includes("Titles in this device's task list, which keeps up to 500 tasks.") &&
    idle.includes("User messages and bot replies in tasks this gateway lets you see. Excludes routine runs, subagent tasks and archived tasks.") &&
    idle.includes("File names returned from workspaces the palette can verify. Some folders may be skipped.") &&
    idle.includes("Links in the conversations loaded on this device: 2 now.") &&
    idle.includes("Routine names, descriptions and bot details.") &&
    idle.includes("The sections of Clawtrate's Settings."),
);
check("S3 the foot says the keys", (await text(p, ".s-foot")) === "↑↓ Move · ↵ Open · Esc Close");
await type(p, "transcode");
await p.keyboard.press("Tab");
check("S12 Tab stays in the field on the desktop", await p.evaluate(() => document.activeElement.id === "s-field"));
await p.keyboard.press("Escape");
check("S12 Escape closes the palette and returns focus to what had it; the background is live again", !(await paletteOpen(p)) && (await p.evaluate(() => document.activeElement.classList.contains("composer-input") && !document.querySelector(".shell").inert)));
await button.click();
await p.waitForTimeout(120);
check("S2 the query is not kept: the palette opens empty again", (await p.inputValue("#s-field")) === "" && (await body(p)).includes("What search looks in"));
check("S2 the query is not written to the device's storage", await p.evaluate(() => !Object.keys(localStorage).some((k) => (localStorage.getItem(k) || "").includes("transcode"))));
await p.keyboard.press("Escape");
check("S12 Escape returns focus to the rail's Search button", await p.evaluate(() => document.activeElement.dataset.action === "search"));
await p.evaluate(() => { const d = document.createElement("dialog"); document.body.append(d); d.showModal(); });
await p.keyboard.press("Meta+k");
check("S3 ⌘K does nothing while another modal dialog is open", !(await paletteOpen(p)));
await p.close();

p = await open("platform=other");
check("Decision: elsewhere the tooltip is Search (Ctrl+K), and Ctrl+K opens the palette", (await p.locator('[data-action="search"]').getAttribute("title")) === "Search (Ctrl+K)" && (await (async () => { await p.keyboard.press("Control+k"); await p.waitForTimeout(100); return paletteOpen(p); })()));
await p.close();

// R1: an empty search accounts for every source ----------------------------------------------------------------
p = await open("palette=open");
await recordLive(p);
await type(p, "ephyr");
check("R1 an unverified workspace: no 'No results' title; Files keeps its own lines", !(await body(p)).includes("No results for") && (await groupText(p, "files")).includes("Not searched: Marlow's workspace could not be verified.") && (await groupText(p, "files")).includes("3 of 4 bots' workspaces searched."));
check("R1 the sources that finished are named, with what they covered", (await text(p, ".s-nomatch")).includes("No matches in Bots, Tasks, Messages, Links, Routines and Settings") && (await text(p, ".s-nomatch")).includes("Links in the 2 conversations this device has loaded."));
await p.waitForTimeout(300);
check("R1 the live region says the same, never 'No results'", (await live(p)) === "No matches in Bots, Tasks, Messages, Links, Routines and Settings. 1 bot's workspace was not searched.", await live(p));
await p.close();

p = await open("palette=open&marlow=workspace");
await type(p, "ephyr");
const none = await body(p);
check("R1 all four workspaces answered: no 'No results' title; the sources that finished are named, and Files keeps its qualification", !none.includes("No results for") && (await text(p, ".s-nomatch")).includes("No matches in Bots, Tasks, Messages, Links, Routines and Settings") && (await groupText(p, "files")).includes("Names the gateway returned from the workspaces of Juniper, Marlow, Otto and Pip. Some folders may be skipped.") && (await groupText(p, "files")).includes("No file names returned from Juniper, Marlow, Otto and Pip."));
await p.waitForTimeout(300);
check("R1 and the live region names the finished sources and the Files qualification, never No results", (await live(p)) === "No matches in Bots, Tasks, Messages, Links, Routines and Settings. Some folders may be skipped.", await live(p));
await p.close();

for (const scope of ["bots", "messages"]) {
  p = await open(`palette=open&width=phone&scope=${scope}`, { width: 390, height: 844 });
  await type(p, "ephyr");
  await p.waitForTimeout(300);
  const solo = await body(p);
  check(`R1 a complete ${scope} scope with no hits still says No results, with what it covered`, solo.includes("No results for “ephyr”") && (scope === "bots" || solo.includes("Messages match the words you type; the end of your query can match the start of a word.")) && (await live(p)) === "No results for ephyr.", await live(p));
  await p.close();
}

p = await open("palette=open&marlow=workspace&src=msgfail&links=none");
await type(p, "ephyr");
await p.waitForTimeout(300);
const failBody = await body(p);
check("R1 a failed source and no loaded conversation: no 'No results' title", !failBody.includes("No results for") && (await groupText(p, "messages")).includes("Couldn't search messages") && (await groupText(p, "links")).includes("No conversation is loaded on this device yet"));
check("R1 and the live region names both", (await live(p)).includes("Messages couldn't be searched.") && (await live(p)).includes("No conversation is loaded, so no links were searched.") && !(await live(p)).includes("No results"), await live(p));
await p.close();

p = await open("palette=open&marlow=workspace&src=indexing");
await type(p, "ephyr");
check("R1 zero hits while indexing is not 'No results'", !(await body(p)).includes("No results for") && (await groupText(p, "messages")).includes("0 matches returned, newest first.") && (await groupText(p, "messages")).includes("Some messages are still being indexed."));
await p.close();

p = await open("palette=open&marlow=workspace&src=slow", undefined, { clock: true });
await recordLive(p);
await p.fill("#s-field", "ephyr");
await p.clock.runFor(1000);
check("R1 while a source is pending nothing is announced and there is no title", !(await body(p)).includes("No results") && (await groupText(p, "messages")).includes("Searching…") && !(await said(p)).length);
await p.clock.runFor(8000);
check("R1 a timeout is said in its group, and never as 'No results'", (await groupText(p, "messages")).includes("Couldn't search messages: the gateway didn't answer in 8 seconds.") && !(await body(p)).includes("No results for"));
await p.clock.runFor(1000);
check("R1 the timeout's announcement names it", (await said(p)).some((t) => t.includes("Messages couldn't be searched.")) && !(await said(p)).some((t) => t.includes("No results")));
await activate(p, "Try again");
await p.keyboard.press("Enter");
await p.clock.runFor(8500); // past the second deadline: slow never answers
check("R1 with slow, Try again times out again", (await groupText(p, "messages")).includes("Couldn't search messages: the gateway didn't answer in 8 seconds.") && (await requests(p, "messages")).length === 2);
await p.close();

// Skipped, capped, failed and offline, alone and together, with and without hits: never a title,
// never a combined count, and each limit said.
for (const [query, extra, says] of [
  ["md", "marlow=workspace&src=filescap", ["The file search stopped at its limit for Otto."]],
  ["ephyr", "src=msgfail", ["Messages couldn't be searched.", "1 bot's workspace was not searched."]],
  ["md", "src=filescap,msgfail", ["Messages couldn't be searched.", "The file search stopped at its limit for Otto.", "1 bot's workspace was not searched."]],
  ["ephyr", "banner=offline", ["No matches in Bots, Tasks, Links and Settings.", "Messages weren't searched: the gateway isn't connected.", "Files weren't searched: the gateway isn't connected."]],
  ["disk", "banner=offline", ["Messages weren't searched: the gateway isn't connected."]],
]) {
  p = await open(`palette=open&${extra}`);
  await type(p, query);
  await p.waitForTimeout(300);
  const l = await live(p);
  check(`R1 ${extra} for ${query}: no title, no combined count, and the limits said`, !(await body(p)).includes("No results for") && !/\d+ results?:/.test(l) && says.every((x) => l.includes(x)), l);
  await p.close();
}

p = await open("palette=open&marlow=workspace&roster=failed&state=partial");
await type(p, "ephyr");
check("R1 a failed roster read keeps cached coverage in view", (await groupText(p, "bots")).includes("Couldn't load the gateway's bots. Showing the bots loaded before.") && (await groupText(p, "tasks")).includes("Couldn't load the task list.") && !(await body(p)).includes("No results for"));
await p.close();
p = await open("palette=open&marlow=workspace&state=partial");
await type(p, "ephyr");
check("Decision: a cut-short task list keeps its coverage line with no title matching", (await groupText(p, "tasks")).includes("which was cut short: it holds the most recent tasks only") && !(await body(p)).includes("No results for"));
await p.close();
p = await open("palette=open&state=discovering&marlow=workspace");
await type(p, "ephyr");
check("R1 an empty cached bot list is not an all-clear", (await groupText(p, "bots")).includes("The gateway's bots haven't loaded yet.") && !(await body(p)).includes("No results for"));
await p.waitForTimeout(300);
check("R1 with no eligible workspace Files settles at once, with nothing pending, and says why", (await groupText(p, "files")).includes("Not searched: the gateway's bots haven't loaded yet.") && !(await groupText(p, "files")).includes("Searching…") && (await requests(p, "files")).length === 0 && (await live(p)).includes("Files weren't searched: the gateway's bots haven't loaded yet."), await live(p));
await p.close();

p = await open("palette=open");
await recordLive(p);
await p.fill("#s-field", "transcode");
await p.waitForTimeout(500);
await p.fill("#s-field", "ephyr");
await settle(p);
check("R1 an announcement queued for a query is dropped when the text changes", !(await said(p)).some((t) => t.includes("3 messages")), (await said(p)).join(" / "));
await p.close();

p = await open("palette=open&width=phone&scope=bots", { width: 390, height: 844 });
await recordLive(p);
await type(p, "backup");
check("R1 the phone announces only its visible scope", (await said(p)).length > 0 && !(await said(p)).some((t) => /message|file|routine/i.test(t)), (await said(p)).join(" / "));
check("S11 a scope asks only its own sources", (await requests(p)).length === 0);
await p.close();

p = await open("palette=open&width=phone&scope=groups", { width: 390, height: 844 });
await recordLive(p);
await type(p, "backup");
check("R1 Group Chats always says its one line, with no request and never No results", (await said(p)).length > 0 && (await said(p)).every((t) => t === "Group chats aren't part of Clawtrate yet.") && (await requests(p)).length === 0, (await said(p)).join(" / "));
await p.close();

// Changing scope while a hidden source is still widening: what is said belongs to the chosen scope.
p = await open("palette=open&width=phone&scope=messages&q=backup&bots=30&each=1&src=eachfail", { width: 390, height: 844 });
await p.waitForTimeout(450);
await recordLive(p);
await p.click('[data-scope="groups"]');
await p.waitForTimeout(1500);
check("R1 a scope change drops the hidden widening's announcement", (await said(p)).length > 0 && (await said(p)).every((t) => t === "Group chats aren't part of Clawtrate yet."), (await said(p)).join(" / "));
await p.close();

// R2: older work is dropped (a fake clock) ------------------------------------------------------------------------
p = await open("palette=open&delay=600", undefined, { clock: true });
await p.fill("#s-field", "transcode");
await p.clock.runFor(260); // transcode is sent; its reply is due 600 ms later
await p.clock.runFor(440);
await p.fill("#s-field", "backup"); // before backup is sent
await p.clock.runFor(200); // transcode's reply arrives now
check("R2 a reply that arrives after new text, before that text is sent, is dropped", !(await body(p)).includes("transcode") && (await groupText(p, "messages")).includes("Searching…") && (await requests(p, "messages")).length === 1);
await p.clock.runFor(900);
check("R2 then only the new text's reply is drawn", (await groupText(p, "messages")).includes("Week 1: backup done") && !(await body(p)).includes("transcode cache"));
await p.close();

p = await open("palette=open&delay=600", undefined, { clock: true });
await p.fill("#s-field", "transcode");
await p.clock.runFor(300);
await p.fill("#s-field", "backup");
await p.clock.runFor(300); // backup's turn has come, but transcode is still out
const queued = await requests(p, "messages");
await p.clock.runFor(300); // transcode's reply arrives: dropped, and backup is sent
const after = await requests(p, "messages");
check("R2 one request in flight: the new text waits, and only the latest is sent", queued.length === 1 && after.length === 2 && after[1].query === "backup");
check("R2 a reply that arrives after the new text was sent is dropped", !(await body(p)).includes("transcode") && (await p.evaluate(() => CT.searchTest.answered.filter((a) => a.source === "messages")[0].current === false)));
await p.clock.runFor(700);
check("R2 the latest reply is drawn", (await groupText(p, "messages")).includes("Week 1: backup done"));
await p.close();

// A is in flight, B has passed the pause and waits for the lane, and C is typed just before A answers.
p = await open("palette=open&delay=600", undefined, { clock: true });
await p.clock.pauseAt(new Date("2026-11-18T22:00:05Z")); // a paused clock: only runFor moves it
await p.fill("#s-field", "transcode"); // A
await p.clock.runFor(260); // A is sent; its reply is due at 850
await p.fill("#s-field", "backup"); // B
await p.clock.runFor(300); // B's pause has passed: it waits for the lane
const waiting = await requests(p, "messages");
await p.clock.runFor(270);
await p.fill("#s-field", "heat"); // C, just before A answers
await p.evaluate(() => {
  window.__staleB = false;
  const seen = () => (window.__staleB ||= document.querySelector("#s-body").innerText.includes("backup done"));
  new MutationObserver(seen).observe(document.querySelector("#s-body"), { childList: true, characterData: true, subtree: true });
});
await p.clock.runFor(100); // A answers: dropped
await p.clock.runFor(2000); // C is sent after its pause, and answers
check("R2 a query waiting for its lane is dropped when newer text arrives: only A and C are sent", waiting.length === 1 && (await requests(p, "messages")).map((r) => r.query).join() === "transcode,heat", (await requests(p, "messages")).map((r) => r.query).join());
check("R2 B's hits never appear while C is in the field, and C's are drawn", !(await p.evaluate(() => window.__staleB)) && (await groupText(p, "messages")).includes("A heat pump is sized"));
await p.close();

p = await open("palette=open&delay=600&platform=mac", undefined, { clock: true });
await p.fill("#s-field", "transcode");
await p.clock.runFor(300);
await p.keyboard.press("Escape");
await p.keyboard.press("Meta+k");
await p.fill("#s-field", "backup");
await p.clock.runFor(2000);
check("R2 a reply from before the palette closed and reopened is dropped", !(await body(p)).includes("transcode") && (await groupText(p, "messages")).includes("Week 1: backup done"));
await p.close();

p = await open("palette=open&src=msgfail&q=transcode");
await settle(p);
await activate(p, "Try again");
await p.keyboard.press("Enter");
await p.fill("#s-field", "ephyr");
await settle(p);
check("R2 a retry started before the text changed does not draw under the new text", !(await body(p)).includes("transcode cache") && !(await body(p)).includes("All 3 matching messages"));
await p.close();

p = await open("palette=open&q=transcode&bot=juniper&task=j1");
await settle(p);
const behind = await p.evaluate(() => document.querySelector(".task-line")?.textContent);
await p.keyboard.press("Enter");
await p.waitForTimeout(60);
await p.fill("#s-field", "ephyr");
await p.waitForTimeout(500);
check("R2 an open started before the text changed does not complete", (await paletteOpen(p)) && !(await p.evaluate(() => document.querySelector(".bubble.search-hit"))));
check("R2 and the conversation behind search stays on its own task", behind === "Heat pump vs. gas furnace" && (await p.evaluate(() => document.querySelector(".task-line")?.textContent)) === behind);
await p.keyboard.press("Escape");
check("R2 after Escape too", (await p.evaluate(() => document.querySelector(".task-line")?.textContent)) === behind);
await p.close();

p = await open("palette=open&q=transcode");
await settle(p);
const before = (await requests(p, "messages")).length;
await p.evaluate(() => window.app.setConnection("reconnecting"));
await p.waitForTimeout(100);
check("R2 a disconnect clears the gateway's results and says they weren't searched", !(await body(p)).includes("transcode cache") && (await groupText(p, "messages")).includes("Not searched: Home gateway isn't connected."));
await p.evaluate(() => window.app.setConnection("connected"));
await settle(p);
check("R2 on reconnect the latest query is asked once", (await requests(p, "messages")).length === before + 1 && (await groupText(p, "messages")).includes("All 3 matching messages"));
await p.close();

p = await open("palette=open&q=worksheet");
await settle(p);
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
const confirmShown = await p.evaluate(() => Boolean(document.querySelector(".s-confirm")) && document.querySelector("#s-body").inert && document.querySelector(".s-top").inert);
await p.evaluate(() => window.app.setConnection("reconnecting"));
await p.waitForTimeout(80);
const confirmGone = await p.evaluate(() => !document.querySelector(".s-confirm"));
await p.evaluate(() => document.querySelector('[data-s="confirm-open"]')?.click());
await p.waitForTimeout(80);
check("R2 a confirmation keeps the rest of the palette inert, a connection change cancels it, and it can't hand off after", confirmShown && confirmGone && (await handoffs(p)).length === 0);
await p.close();

p = await open("palette=open");
await p.fill("#s-field", "rebates");
await p.keyboard.press("Enter"); // a local link row, before the gateway is asked
await p.waitForTimeout(900);
check("R2 a local open started before the pause still completes", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".bubble.search-hit")?.closest(".turn")?.dataset.messageId === "msg-j1-1")));
await p.close();

// R3: message coverage and marks come from the reply -----------------------------------------------------------------
p = await open("palette=open");
await type(p, "transcode");
check("F-033 all matches returned: the coverage line says so, newest first", (await groupText(p, "messages")).includes("All 3 matching messages, newest first"));
check("F-033 newest first", await p.evaluate(() => [...document.querySelectorAll('.s-group[data-group="messages"] .s-time')].map((x) => x.textContent).join() === "5:37 PM,5:36 PM,5:33 PM"));
check("R3 snippets carry no marks: the reply gives no ranges", await p.evaluate(() => !document.querySelector('.s-group[data-group="messages"] .s-second b')));
await type(p, "transcode_cache");
check("R3 a piece with punctuation is a phrase: its words together, in order", (await groupText(p, "messages")).includes("All 3 matching messages"));
await type(p, "cache_transcode");
check("R3 the same words out of order don't match", !(await body(p)).includes("Messages ·"));
await type(p, "transcode-cache");
check("R3 the punctuation example: transcode-cache is the same phrase as transcode_cache", (await groupText(p, "messages")).includes("All 3 matching messages"));
for (const q of ["!", "transcode !", "cache -"]) {
  await type(p, q);
  check(`R3 a piece with no token matches no messages: ${q}`, !(await body(p)).includes("Messages ·") && (await requests(p, "messages")).some((r) => r.query === q));
}
await type(p, "borrow");
check("R3 markup in a snippet is shown as text, never as elements", (await groupText(p, "messages")).includes("Libby shows <em>Borrow</em> once your card is linked.") && (await p.evaluate(() => !document.querySelector("#s-body em"))));
await p.close();

p = await open("palette=open&src=indexing");
await type(p, "transcode");
check("R3 with indexing, never 'All': matches returned, and indexing said", (await groupText(p, "messages")).includes("3 matches returned, newest first.") && (await groupText(p, "messages")).includes("Some messages are still being indexed.") && !(await groupText(p, "messages")).includes("All 3"));
await p.close();
p = await open("palette=open&src=archive");
await type(p, "transcode");
check("R3 the archive count is said", (await groupText(p, "messages")).includes("4 tasks have archived transcript content that wasn't searched."));
await p.close();

p = await open("palette=open");
await type(p, "backup");
let m = await groupText(p, "messages");
check("R3 truncated: the matches the gateway returned, and more indexed messages match", m.includes("Messages · 25") && m.includes("Showing the 25 matches the gateway returned, newest first. More indexed messages match."));
check("F-268 never 'recent' and never 'Search older'", !(await body(p)).includes("Search older") && !(await body(p)).toLowerCase().includes("recent messages"));
check("S7 a group shows 5 rows, then Show all", (await p.locator('.s-group[data-group="messages"] .s-row[data-kind="message"]').count()) === 5 && m.includes("Show all 25 messages"));
const sent = (await requests(p, "messages")).length;
await activate(p, "Search each bot for more");
await p.keyboard.press("Shift+Enter");
check("R7 Shift+Enter on an action row does nothing", (await requests(p, "messages")).length === sent);
await p.keyboard.press("Enter");
await p.waitForTimeout(20);
m = await groupText(p, "messages");
check("R3 while widening: Searching 4 bots…, with the verified hits kept", m.includes("Searching 4 bots…") && (await p.locator('.s-group[data-group="messages"] .s-row[data-kind="message"]').count()) === 5);
check("R1 while widening nothing says 'No matches in … Messages'", !(await text(p, ".s-nomatch")).includes("Messages"));
await p.waitForTimeout(700);
m = await groupText(p, "messages");
check("R3 after widening: how many bots answered and how many messages came back", m.includes("4 of 4 bots answered. 30 messages returned.") && m.includes("Juniper · no matches") && m.includes("Marlow · all 2 matches") && m.includes("Otto · 25 returned. More match; add words to narrow them.") && m.includes("Pip · all 3 matches"));
check("F-268 searching each bot found what the first search left out", m.includes("Saved a backup copy as the March draft"));
const widening = await open("palette=open&q=backup&each=1&src=eachfail&bots=30", undefined, { clock: true });
await widening.clock.pauseAt(new Date("2026-11-18T22:00:05Z"));
const progress = new Set();
for (let i = 0; i < 120; i++) {
  await widening.clock.runFor(10);
  const first = await widening.evaluate(() => document.querySelector('.s-group[data-group="messages"] .s-line')?.textContent || "");
  if (first.startsWith("Searching")) progress.add(first);
}
const failedApart = [...progress].filter((l) => l.includes("couldn't search"));
const sums = failedApart.map((l) => [...l.matchAll(/(\d+) (?:answered|couldn't search|in progress|queued)/g)].reduce((n, x) => n + Number(x[1]), 0));
check("R3 while widening, a failed bot is never counted as answered", failedApart.length > 0 && failedApart.every((l) => / \d+ answered, 1 couldn't search, /.test(l)) && sums.every((n) => n === 24), [...progress].join(" / "));
await widening.close();
check("S12 the live region says how many bots answered, as Messages' limit, with no combined count", (await live(p)).includes("4 of 4 bots answered. 30 messages returned.") && !/\d+ results?:/.test(await live(p)), await live(p));
await p.close();

p = await open("palette=open&q=backup&each=1&src=eachfail");
await settle(p);
m = await groupText(p, "messages");
check("R3 a failed bot is named, and not counted as answered", m.includes("3 of 4 bots answered.") && m.includes("Pip · couldn't search: the gateway didn't answer in time") && (await live(p)).includes("Pip couldn't be searched."));
await activate(p, "Try again for Pip");
await p.evaluate(() => {
  window.__raw = [];
  new MutationObserver(() => window.__raw.push(document.querySelector("#s-live").textContent)).observe(document.querySelector("#s-live"), { childList: true, characterData: true, subtree: true });
});
await p.keyboard.press("Enter");
await p.waitForTimeout(900);
check("S8 Try again searches that bot again", (await groupText(p, "messages")).includes("Pip · all 3 matches"));
const raw = await p.evaluate(() => window.__raw);
check("R1 while the retry is in progress the earlier status is cleared and nothing is said until it answers", raw[0] === "" && raw.filter(Boolean).length > 0 && raw.filter(Boolean).every((t) => t.includes("4 of 4 bots answered.")), raw.join(" / "));
await p.close();

p = await open("palette=open&q=backup&each=1&src=indexing");
await settle(p);
check("R3 each bot's flags are its own, zero hits included", (await groupText(p, "messages")).includes("Juniper · none returned. Some messages are still being indexed."));
await p.close();
p = await open("palette=open&q=backup&each=1&src=indexing,archive");
await settle(p);
check("R3 a truncated bot's reply keeps its indexing and archive lines", (await groupText(p, "messages")).includes("Otto · 25 returned. More match; add words to narrow them. Some messages are still being indexed. 4 tasks have archived transcript content that wasn't searched."));
await p.close();

p = await open("palette=open&q=backup&each=1&bots=30");
await p.waitForTimeout(1600);
m = await groupText(p, "messages");
check("R3 a large roster: 24 bots asked, the rest named and offered", m.includes("24 of 24 bots answered.") && m.includes("Not asked: Umber, Vale, Wren, Yarrow, Zinnia and Alder.") && m.includes("Search the next 6 bots"));
await activate(p, "Search the next 6 bots");
await p.keyboard.press("Enter");
await p.waitForTimeout(600);
check("R3 the next batch is asked", (await groupText(p, "messages")).includes("30 of 30 bots answered.") && (await requests(p, "messages")).filter((r) => r.scope.agentId).length === 30);
await p.close();

// R4: opening uses the returned ids ---------------------------------------------------------------------------------
p = await open("palette=open");
await recordLive(p);
await type(p, "transcode");
check("S12 the first option is active and named for where it leads", (await p.evaluate(() => document.getElementById(document.querySelector("#s-field").getAttribute("aria-activedescendant"))?.getAttribute("aria-label"))).startsWith("Message in Disk almost full on the media box, from Otto"));
// The reply's role says a user sent it, not that the searcher did, whichever device made the task.
const userRow = await p.evaluate(() => { const r = [...document.querySelectorAll('.s-row[data-kind="message"]')].find((x) => x.innerText.includes("Yes, clear the transcode cache.")); return { first: r.querySelector(".s-first").textContent, name: r.getAttribute("aria-label") }; });
check("R3 a user message is labelled User and named from a user, never You", userRow.first.includes("· User ·") && userRow.name.startsWith("Message in Disk almost full on the media box, from a user,") && !/\byou\b/i.test(userRow.first + userRow.name.split(":")[0]), JSON.stringify(userRow));
await p.keyboard.press("ArrowDown");
await p.keyboard.press("Enter");
await p.waitForTimeout(80);
check("S9 a message opens its task behind the palette, which says Opening…", (await paletteOpen(p)) && (await body(p)).includes("Opening…"));
await p.waitForTimeout(400);
check("R4 it lands on the turn whose id is the returned message id", !(await paletteOpen(p)) && (await p.evaluate(() => { const hit = document.querySelector(".bubble.search-hit"); return hit?.closest(".turn").dataset.messageId === "msg-o1-2" && document.activeElement === hit.closest(".turn"); })));
await p.waitForTimeout(80);
check("S9 the app announces where it opened, at the user message", (await text(p, "#search-announce")).startsWith("Opened Disk almost full on the media box, at the user message of"));
await p.waitForTimeout(2600);
check("S9 the ring fades after 2 seconds", await p.evaluate(() => !document.querySelector(".bubble.search-hit")));
await p.close();

p = await open("palette=open&motion=reduce&q=transcode");
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(3000);
check("S9 with reduced motion the ring stays until the next key", await p.evaluate(() => Boolean(document.querySelector(".bubble.search-hit"))));
await p.keyboard.press("Shift");
await p.waitForTimeout(80);
check("S9 the next key removes it", await p.evaluate(() => !document.querySelector(".bubble.search-hit")));
await p.close();

p = await open("palette=open&q=backup");
await settle(p);
await activate(p, "Week 1: backup done");
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("R4 older than the loaded window, which the window establishes: said, with Open the task at its latest", (await paletteOpen(p)) && (await body(p)).includes("This message is earlier than the 200 messages this conversation shows, so it can't be shown in place.") && (await body(p)).includes("Open the task at its latest"));
await activate(p, "Open the task at its latest");
await p.keyboard.press("Enter");
check("S9 Open the task at its latest closes the palette on that task", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".task-line")?.textContent === "Weekly backup check")));
await p.close();

p = await open("palette=open&q=transcode&missing=1");
await settle(p);
await activate(p, "Clearing the transcode cache");
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("R4 a missing id the window doesn't explain: not in the loaded messages, never 'earlier'", (await body(p)).includes("This message isn't in the conversation's loaded messages.") && !(await body(p)).includes("earlier than") && (await body(p)).includes("Open the task at its latest"));
await p.close();

for (const [gone, line] of [
  ["task", "This task is no longer in this device's task list."],
  ["reset", "This task's conversation was replaced since the search. Search again."],
  ["bot", "Otto is no longer in this connection's list of bots."],
]) {
  p = await open(`palette=open&q=transcode&gone=${gone}`);
  await settle(p);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(120);
  check(`R4 gone=${gone}: the palette stays and says what is known`, (await paletteOpen(p)) && (await body(p)).includes(line) && !(await body(p)).includes("archived or deleted") && !(await p.evaluate(() => document.querySelector(".bubble.search-hit"))));
  await p.close();
}
p = await open("palette=open&q=transcode&gone=unlisted");
await settle(p);
const un = await groupText(p, "messages");
check("R4 a task the list never held: its title from the reply, and why it can't open", un.includes("Old transcode settings") && un.includes("This task isn't in this device's task list, which keeps up to 500 tasks."));
check("R4 its name keeps the returned title and the reason, though the gateway matched a readable task beyond the device's list", (await p.evaluate(() => [...document.querySelectorAll('.s-row[data-kind="message"]')].find((r) => r.innerText.includes("Old transcode settings"))?.getAttribute("aria-label") || "")).match(/^Message in Old transcode settings, .*This task isn't in this device's task list, which keeps up to 500 tasks\.$/) !== null);
await activate(p, "Old transcode settings");
check("S9 its active row says Can't open, and Enter does not open it", (await activeText(p)).includes("Can't open") && (await (async () => { await p.keyboard.press("Enter"); return paletteOpen(p); })()));
await p.close();

p = await open("palette=open&q=transcode&historyfail=1");
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S9 the history fails to load: said under the row, with Try again", (await body(p)).includes("Couldn't load this conversation: the gateway didn't answer in time."));
await activate(p, "Try again");
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S9 Try again opens it in place", !(await paletteOpen(p)) && (await p.evaluate(() => Boolean(document.querySelector(".bubble.search-hit")))));
await p.close();

p = await open("palette=open&q=ott");
await settle(p);
await p.keyboard.press("Enter");
check("R4 a bot result opens that bot", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".title-pill-name")?.textContent === "Otto")));
await p.close();
p = await open("palette=open&q=heat");
await settle(p);
await activate(p, "Heat pump vs. gas furnace");
await p.keyboard.press("Enter");
check("R4 a task result opens that task", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".task-line")?.textContent === "Heat pump vs. gas furnace")));
await p.close();
p = await open("palette=open&q=rebates");
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("R4 a link goes to the message it came from, by its id", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".bubble.search-hit")?.closest(".turn")?.dataset.messageId === "msg-j1-1")));
await p.close();

// R5: files, from verified workspaces ----------------------------------------------------------------------------------
p = await open("palette=open");
await type(p, "t");
check("S6 files ask for 2 characters, and aren't counted as searched", (await groupText(p, "files")).includes("Type 2 or more characters to search file names.") && (await requests(p, "files")).length === 0);
await type(p, "pictures");
const pf = await groupText(p, "files");
check("R5 only file entries: a folder whose name matches is not a result", pf.includes("trail-map.png") && (await p.locator('.s-group[data-group="files"] .s-row[data-kind="file"]').count()) === 1);
check("R5 names returned, folders may be skipped, empty replies and the unverified bot named, and the count", pf.includes("Names the gateway returned from the workspaces of Juniper, Otto and Pip. Some folders may be skipped.") && pf.includes("No file names returned from Juniper and Otto.") && pf.includes("Not searched: Marlow's workspace could not be verified.") && pf.includes("3 of 4 bots' workspaces searched."));
await p.close();

p = await open("palette=open&src=filesnoroot,filescap");
await type(p, "md");
const nf = await groupText(p, "files");
check("R5 an omitted root and a capped walk are each said", nf.includes("Juniper: the gateway returned no workspace for its task, so nothing was searched.") && nf.includes("Otto: the gateway stopped at its limit of 500 names or 5,000 entries walked."));
await p.close();

p = await open("palette=open&src=filesfail");
await type(p, "md");
check("R5 a refused search is said for that bot", (await groupText(p, "files")).includes("Pip: the gateway refused the search: the gateway refused the request."));
const fbefore = await requests(p, "files");
await activate(p, "Try again for Pip");
await p.keyboard.press("Enter");
await p.waitForTimeout(500);
const fafter = await requests(p, "files");
check("R5 Try again asks only the failed bot", fafter.length === fbefore.length + 1 && fafter.at(-1).sessionKey === "agent:pip:p1" && (await groupText(p, "files")).includes("Names the gateway returned from the workspaces of Juniper, Otto and Pip.") && !(await groupText(p, "files")).includes("refused"));
await p.close();

p = await open("palette=open&src=filestimeout", undefined, { clock: true });
await p.fill("#s-field", "md");
await p.clock.runFor(9000);
check("R5 a timeout is said for that bot", (await groupText(p, "files")).includes("Juniper: the gateway didn't answer in 8 seconds."));
await p.close();

p = await open("palette=open&bots=30");
await type(p, "backup");
await p.waitForTimeout(400);
const big = await groupText(p, "files");
check("R5 8 bots asked per batch, the rest named, and how many were searched", (await requests(p, "files")).length === 8 && big.includes("Not asked yet:") && big.includes("Search the next 8 bots' files") && big.includes("8 of 30 bots' workspaces searched."));
await activate(p, "Search the next 8 bots' files");
await p.keyboard.press("Enter");
await p.waitForTimeout(800);
check("R5 the next batch is asked", (await requests(p, "files")).length === 16 && (await groupText(p, "files")).includes("16 of 30 bots' workspaces searched."));
await p.close();

// A slow first batch: no next-batch action while it is out, and a new query waits for the pool.
p = await open("palette=open&bots=30&src=slow", undefined, { clock: true });
await p.clock.pauseAt(new Date("2026-11-18T22:00:05Z"));
await p.fill("#s-field", "backup");
await p.clock.runFor(1000);
const slowFiles = await groupText(p, "files");
check("R5 while a slow first batch is out there is no next-batch action", (await requests(p, "files")).length === 4 && !slowFiles.includes("Search the next 8 bots' files"), slowFiles);
await p.fill("#s-field", "backups");
await p.clock.runFor(1000);
const whileOut = (await requests(p, "files")).length;
await p.clock.runFor(8000); // the first query's requests time out; the new query's are sent
check("R5 typing a new query never puts more than 4 Files requests in flight", whileOut === 4 && (await requests(p, "files")).length === 8 && (await p.evaluate(() => CT.searchTest.peak.files)) === 4, `${whileOut} ${await p.evaluate(() => CT.searchTest.peak.files)}`);
await p.close();

// A retry goes through the same lane: offered only once the batch has settled, and never a fifth request.
p = await open("palette=open&bots=30&src=filesfail");
await type(p, "backup");
await activate(p, "Search the next 8 bots' files");
await p.keyboard.press("Enter");
const batchOut = await p.evaluate(() => [...document.querySelectorAll('.s-group[data-group="files"] .s-action')].map((a) => a.textContent));
await p.waitForTimeout(900);
await activate(p, "Try again for Pip");
await p.keyboard.press("Enter");
await p.waitForTimeout(600);
check("R5 while a batch is out no retry or next batch is offered, and a retry never puts Files above 4 in flight", !batchOut.some((a) => a.startsWith("Try again") || a.startsWith("Search the next")) && (await groupText(p, "files")).includes("Names the gateway returned from the workspaces of") && !(await groupText(p, "files")).includes("refused") && (await p.evaluate(() => CT.searchTest.peak.files)) <= 4, `${batchOut.join(" | ")} peak ${await p.evaluate(() => CT.searchTest.peak.files)}`);
await p.close();

// A file name doesn't bind a reader to the workspace searched: file results are names, with no
// open hint, on the desktop and the iPhone, and nothing opens or is read.
const fileLine = "Opening a file from search is unavailable until the gateway can bind the read to the workspace searched.";
for (const [query, file, how, extra, viewport] of [
  ["md", "disk-2026-11-16.md", "Enter", "", undefined],
  ["trail", "trail-map.png", "click", "", undefined],
  ["disk", "disk-2026-11-16.md", "click", "&platform=ios&width=phone", { width: 390, height: 844 }],
]) {
  p = await open("palette=open" + extra, viewport);
  await type(p, query);
  const asked = (await requests(p)).length;
  const row = p.locator(`.s-row[data-kind="file"]:has-text("${file}")`);
  const hintless = await row.evaluate((r) => !r.querySelector(".s-hint"));
  if (how === "Enter") {
    await activate(p, file);
    await p.keyboard.press("Enter");
  } else await row.click();
  await p.waitForTimeout(300);
  check(`R5 ${file}${extra ? " on the iPhone" : ""}: the name stays in the palette, with no open hint and the reason, and no Work route or read is asked`, hintless && (await paletteOpen(p)) && p.url().includes("search.html") && !p.url().includes("work.html") && (await groupText(p, "files")).includes(file) && (await row.innerText()).includes(fileLine) && (await requests(p)).length === asked);
  await p.close();
}

// R6 and the alignments: the full address, and when to confirm ------------------------------------------------------------
p = await open("palette=open");
await type(p, "sizing");
check("R6 a link row shows its host, then the full canonical address, scheme included", await p.evaluate(() => { const r = document.querySelector('.s-row[data-kind="link"]'); return r.querySelector(".s-host").textContent === "energy.example" && r.querySelector(".s-address").textContent === "https://energy.example/heat-pumps/sizing-guide"; }));
check("S3 a link row adds Shift+Enter to the foot", (await text(p, ".s-foot")).includes("⇧↵ Open in browser"));
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
check("A4 an address shown in full opens directly, with no confirmation", !(await p.evaluate(() => document.querySelector(".s-confirm"))) && JSON.stringify(await handoffs(p)) === JSON.stringify([{ url: "https://energy.example/heat-pumps/sizing-guide", confirmed: false }]));
await p.close();

p = await open("palette=open");
await type(p, "worksheet");
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
const conf = await p.evaluate(() => ({ host: document.querySelector(".s-confirm-host")?.textContent, address: document.querySelector(".s-confirm-address")?.textContent, line: document.querySelector(".s-confirm-line")?.textContent, role: document.querySelector(".s-confirm")?.getAttribute("role") }));
check("A4 a clipped address confirms first, host first, then the full canonical address", conf.role === "alertdialog" && conf.host === "energy.example" && conf.address === "https://energy.example/heat-pumps/sizing-guide/appendix/heat-loss-worksheet?climate-zone=5A&rooms=kitchen,living,bedrooms,basement&units=imperial#step-4" && conf.line === "Opens in your browser.");
check("R6 nothing is handed over before Open", (await handoffs(p)).length === 0);
const clipped = await open("palette=open&q=sizing", { width: 1440, height: 420 });
await settle(clipped);
const box = await clipped.evaluate(() => {
  // Scroll the list so the address, untruncated inside its own box, is cut by the list's top edge.
  const body = document.querySelector("#s-body");
  const a = document.querySelector('.s-row[data-kind="link"] .s-address');
  body.scrollTop += a.getBoundingClientRect().top - body.getBoundingClientRect().top + a.getBoundingClientRect().height / 2;
  const r = a.getBoundingClientRect();
  const v = body.getBoundingClientRect();
  return { own: a.scrollHeight <= a.clientHeight + 1 && a.scrollWidth <= a.clientWidth + 1, cut: r.top < v.top && r.bottom > v.top, link: document.getElementById(document.querySelector("#s-field").getAttribute("aria-activedescendant"))?.dataset.kind };
});
await clipped.keyboard.press("Shift+Enter");
await clipped.waitForTimeout(80);
check("A4 an address whole in its own box but cut by the list's edge confirms first, with nothing handed over", box.own && box.cut && box.link === "link" && (await clipped.evaluate(() => document.querySelector(".s-confirm-address")?.textContent)) === "https://energy.example/heat-pumps/sizing-guide" && (await handoffs(clipped)).length === 0, JSON.stringify(box));
await clipped.close();
await p.keyboard.press("Meta+k");
check("R7 ⌘K over the confirmation keeps focus in it", await p.evaluate(() => document.activeElement.closest(".s-confirm") !== null));
await p.click('[data-s="confirm-open"]');
await p.waitForTimeout(80);
check("R6 Open hands over the same canonical address it showed", JSON.stringify(await handoffs(p)) === JSON.stringify([{ url: conf.address, confirmed: true }]) && !(await paletteOpen(p)));
await p.close();

p = await open("palette=open&q=worksheet");
await settle(p);
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
await p.evaluate(() => {
  // Open, then search reopened and typed in before the app's own announcement is spoken.
  document.querySelector('[data-s="confirm-open"]').click();
  document.querySelector('[data-action="search"]').click();
  const f = document.querySelector("#s-field");
  f.value = "rebates";
  f.dispatchEvent(new Event("input", { bubbles: true }));
});
await p.waitForTimeout(200);
check("R2 reopening search and typing before the app's announcement leaves that region empty", (await handoffs(p)).length === 1 && (await paletteOpen(p)) && (await text(p, "#search-announce")) === "");
await p.close();

p = await open("palette=open&platform=mac");
await type(p, "127.0.0.1");
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
check("A2 a loopback address shown in full still confirms: it points to this device, scheme shown", (await text(p, ".s-confirm-address")) === "http://127.0.0.1:8080/status" && (await text(p, ".s-confirm-line")) === "Opens in your browser. This address points to this device.");
await p.keyboard.press("Escape");
check("R7 the first Escape closes the confirmation only", (await paletteOpen(p)) && !(await p.evaluate(() => document.querySelector(".s-confirm"))) && (await p.evaluate(() => document.activeElement.id === "s-field")));
await p.keyboard.press("Escape");
check("R7 the second Escape closes the palette", !(await paletteOpen(p)) && (await handoffs(p)).length === 0);
await p.keyboard.press("Meta+k");
await type(p, "fd00");
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
check("A2 a private address: may be on your own network", (await text(p, ".s-confirm-line")) === "Opens in your browser. This address may be on your own network.");
await p.close();

p = await open("palette=open");
const where = await p.evaluate(() => {
  const w = (raw) => { const c = CT.searchTest.canonical(raw); return c.url ? CT.searchTest.whereIs(c.hostname) : "refused"; };
  return ["http://[::1]/", "http://localhost:3000/", "http://dev.localhost/", "http://[::ffff:127.0.0.1]/", "http://167772168/", "http://2886992129/", "http://2851995905/", "http://1681915913/", "http://[fe80::1]/", "http://[fd00::5]/", "http://[64:ff9b::808:808]/", "http://printer/", "http://nas.local./", "https://energy.example/", "https://134744072/", "https://[2606:4700::1111]/", "http://0x7f.1/", "http://[2002:c000:204::1]/", "http://[3fff:10::1]/", "http://3221225480/", "http://[2001:2::1]/", "https://3221225481/", "https://[2001:4:112::1]/", "https://[::ffff:c000:a]/"].map(w);
});
check("A2 6to4 and 3fff::/20 are refused; the globally reachable PCP anycast address and 2001:4:112::/48 inside refused blocks stay direct; the written host decides once the URL parser has canonicalized it (integer IPv4 included), with no lookup", where.join() === "self,self,self,self,network,network,network,network,network,network,network,network,network,,,,self,network,network,network,network,,,", where.join());
await type(p, "installer");
const refused = await groupText(p, "links");
check("R6 an address with a user name or password is plain text and can't be handed over", refused.includes("https://sam:hunter2@installer.example.com/portal") && (await p.evaluate(() => !document.querySelector('.s-row[data-kind="link"] .s-hint-more'))));
await p.keyboard.press("Shift+Enter");
check("R6 Shift+Enter on it does nothing", !(await p.evaluate(() => document.querySelector(".s-confirm"))) && (await handoffs(p)).length === 0);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("R6 Enter still goes to the message it came from", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".bubble.search-hit")?.closest(".turn")?.dataset.messageId === "msg-j1-1")));
await p.close();

p = await open("palette=open&links=none");
check("S4 with no conversation loaded, the links line says so", (await body(p)).includes("Links in conversations you open. None is loaded now."));
await p.close();

// R7: the phone and the iPhone -------------------------------------------------------------------------------------------
p = await open("palette=open&width=phone", { width: 390, height: 844 });
await type(p, "sizing");
check("R7 on a narrow desktop a link row has an Open link option", await p.evaluate(() => [...document.querySelectorAll(".s-action")].some((a) => a.textContent === "Open link" && a.getAttribute("aria-label") === "Open https://energy.example/heat-pumps/sizing-guide in your browser")));
await p.click('.s-action:text-is("Open link")');
await p.waitForTimeout(80);
check("R7 tapping it hands over under the same address rule", (await handoffs(p)).length === 1 && (await handoffs(p))[0].url === "https://energy.example/heat-pumps/sizing-guide");
await p.close();
p = await open("palette=open&width=phone", { width: 390, height: 844 });
await type(p, "status");
await p.click('.s-action:text-is("Open link")');
await p.waitForTimeout(80);
check("A3 the narrow desktop keeps 'Opens in your browser'", (await text(p, ".s-confirm-line")) === "Opens in your browser. This address points to this device.");
await p.close();

p = await open("palette=open&platform=ios&width=phone", { width: 390, height: 844 });
await type(p, "status");
check("A3 the iPhone's action names where it opens", await p.evaluate(() => [...document.querySelectorAll(".s-action")].some((a) => a.getAttribute("aria-label") === "Open http://127.0.0.1:8080/status outside Clawtrate")));
await p.click('.s-action:text-is("Open link")');
await p.waitForTimeout(80);
check("A3 the iPhone says 'Opens outside Clawtrate'", (await text(p, ".s-confirm-line")) === "Opens outside Clawtrate. This address points to this device.");
await p.click('[data-s="confirm-cancel"]');
await p.focus("#s-field");
await p.keyboard.press("Enter");
await p.waitForTimeout(400);
check("R7 the iPhone's Search key hides the keyboard and opens nothing", (await paletteOpen(p)) && (await p.evaluate(() => document.activeElement.id !== "s-field")) && !(await body(p)).includes("Opening…"));
await p.close();
p = await open("palette=open&platform=ios&keyboard=hardware&width=phone&q=transcode", { width: 390, height: 844 });
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("R7 a hardware keyboard's Enter still opens the active result", !(await paletteOpen(p)));
await p.close();

p = await open("palette=open&q=backup&width=phone", { width: 390, height: 844 });
await settle(p);
const scopes = await p.evaluate(() => [...document.querySelectorAll('.s-scopes [role="tab"]')].map((t) => t.textContent));
check("F-240 the phone has the scopes All, Messages, Bots, Group Chats, Files and Routines", scopes.join() === "All,Messages,Bots,Group Chats,Files,Routines", scopes.join());
check("R7 the results panel is labelled by the chosen tab", await p.evaluate(() => { const b = document.querySelector("#s-body"); return b.getAttribute("role") === "tabpanel" && b.getAttribute("aria-labelledby") === "s-scope-all"; }));
check("S11 All shows 3 rows a group, then See all", (await p.locator('.s-group[data-group="messages"] .s-row[data-kind="message"]').count()) === 3 && (await groupText(p, "messages")).includes("See all 25 messages"));
await activate(p, "See all 25 messages");
await p.keyboard.press("Enter");
check("S11 See all chooses that group's scope", await p.evaluate(() => document.querySelector('[data-scope="messages"]').getAttribute("aria-selected") === "true" && document.querySelectorAll('.s-group[data-group="messages"] .s-row[data-kind="message"]').length === 25));
check("S11 Messages shows tasks, messages and links only", await p.evaluate(() => [...document.querySelectorAll(".s-group")].every((g) => ["tasks", "messages", "links"].includes(g.dataset.group))));
await p.focus('[data-scope="messages"]');
await p.keyboard.press("ArrowRight");
check("S12 Right on the scope bar moves to and chooses Bots", await p.evaluate(() => document.activeElement.dataset.scope === "bots" && document.activeElement.getAttribute("aria-selected") === "true"));
await p.keyboard.press("ArrowRight");
check("F-240 Group Chats says they aren't part of Clawtrate yet", (await body(p)).trim() === "Group chats aren't part of Clawtrate yet.");
await p.keyboard.press("End");
await p.waitForTimeout(600);
check("R7 focus stays on the scope while its group fills in", await p.evaluate(() => document.activeElement.dataset.scope === "routines") && (await body(p)).includes("Nightly backup check"));
await p.click(".s-cancel");
check("S11 Cancel closes search", !(await paletteOpen(p)));
await p.close();

p = await open("palette=open&width=phone", { width: 390, height: 844 });
await type(p, "s");
check("R8 on the phone All shows every Settings row: there is no Settings scope", (await p.locator('.s-group[data-group="settings"] .s-row').count()) === (await p.evaluate(() => document.querySelectorAll('.s-group[data-group="settings"] .s-row').length)) && !(await groupText(p, "settings")).includes("See all"));
await p.close();

p = await open("palette=open&q=transcode&width=phone", { width: 390, height: 844 });
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S11 on a narrow desktop, opening a result closes search and shows the conversation", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".shell").dataset.view === "detail" && Boolean(document.querySelector(".bubble.search-hit")))));
await p.close();

p = await open("palette=open&width=phone", { width: 390, height: 420 });
await type(p, "backup");
for (let i = 0; i < 6; i++) await p.keyboard.press("ArrowDown");
check("R7 on a short screen the field and the active row stay in view", await p.evaluate(() => { const f = document.querySelector("#s-field").getBoundingClientRect(); const a = document.getElementById(document.querySelector("#s-field").getAttribute("aria-activedescendant")).getBoundingClientRect(); const b = document.querySelector("#s-body").getBoundingClientRect(); return f.top >= 0 && f.bottom <= innerHeight && a.top >= b.top - 1 && a.bottom <= b.bottom + 1; }));
await p.close();

p = await open("palette=open", { width: 1100, height: 560 }, { clock: true });
await p.fill("#s-field", "backup");
await p.clock.runFor(400); // messages answered; files not yet
await p.evaluate(() => (document.querySelector("#s-body").scrollTop = 160));
await p.clock.runFor(600);
check("R7 the list's scroll survives a group filling in", (await p.evaluate(() => document.querySelector("#s-body").scrollTop)) === 160 && (await groupText(p, "files")).includes("workspaces searched"));
await p.close();

// R8 and the routine page: Settings that exist, routine pages ------------------------------------------------------------------
p = await open("palette=open");
await type(p, "acc");
await p.keyboard.press("Enter");
await p.waitForURL(/controls\.html/);
await p.waitForTimeout(250);
check("S9 a setting opens Settings at its section", p.url().includes("section=accounts") && (await p.evaluate(() => [...document.querySelectorAll("dialog")].some((d) => d.open))));
const exists = [];
for (const id of ["gateway", "accounts", "integrations", "permissions", "memory", "usage", "machines"]) {
  await p.goto(pageUrl("controls.html") + `?chrome=0&open=settings&section=${id}`);
  await p.waitForTimeout(150);
  exists.push(await p.evaluate((s) => Boolean(document.querySelector(`[data-b-section="${s}"][aria-current="page"]`)), id));
}
check("R8 every Settings row's section exists in the Settings it opens", exists.every(Boolean), exists.join());
await p.close();

p = await open("palette=open&bot=juniper&task=j1");
await type(p, "tidy");
const routines = await groupText(p, "routines");
check("R8 routines: names, descriptions and bot details; on or off", routines.includes("Matches routine names, descriptions and bot details") && routines.includes("Inbox tidy-up") && routines.includes("Pip · Off"));
check("A1 a routine row says Open routine, and its name says so", (await activeText(p)).includes("Open routine") && (await p.evaluate(() => document.querySelector('.s-row[data-kind="routine"]').getAttribute("aria-label"))) === "Routine Inbox tidy-up, Pip, off. Opens routine.");
await p.keyboard.press("Enter");
await p.waitForURL(/routines\.html/);
await p.waitForTimeout(300);
check("A1 a routine opens its own page by its id, with Back", p.url().includes("view=routine&routine=cleanup") && (await text(p, "#view-title")) === "Inbox tidy-up" && (await p.evaluate(() => document.querySelector('[data-r="back"]')?.getAttribute("aria-label") === "Back to the conversation")));
await p.click('[data-r="back"]');
await p.waitForURL(/search\.html/);
await p.waitForTimeout(250);
check("A1 Back returns to the conversation search was opened over, not the Routines list", (await p.evaluate(() => document.querySelector(".task-line")?.textContent)) === "Heat pump vs. gas furnace" && !(await paletteOpen(p)) && !p.url().includes("tidy"));
await p.goto(base + "&palette=open");
await type(p, "cleanup");
check("R8 a match on the id alone is labelled", (await groupText(p, "routines")).includes("Matched its id, cleanup"));
await p.close();

p = await open("palette=open&routinepage=3", undefined, { clock: true });
await p.clock.pauseAt(new Date("2026-11-18T22:00:05Z"));
await p.fill("#s-field", "e");
await p.clock.runFor(1500);
check("R8 a paged list says how far it is and offers the next page", (await groupText(p, "routines")).includes("First 3 of 7") && (await groupText(p, "routines")).includes("Show 3 more routines"));
const pagedSaid = await live(p);
await activate(p, "Show 3 more routines");
await p.keyboard.press("Enter");
const inFlight = { loading: (await groupText(p, "routines")).includes("Loading more…"), said: await live(p) };
await p.clock.runFor(150);
inFlight.later = await live(p);
check("R1 while a routine page is in flight its earlier status is cleared and nothing is announced", pagedSaid !== "" && inFlight.loading && inFlight.said === "" && inFlight.later === "", JSON.stringify([pagedSaid, inFlight]));
await p.clock.runFor(1000);
check("R1 once the page answers, the region speaks again", (await live(p)) !== "");
await activate(p, "Show 1 more routine");
await p.keyboard.press("Enter");
await p.clock.runFor(400);
check("R8 the last page: all of them, and no more to show", (await groupText(p, "routines")).includes("All 7 routines") && !(await groupText(p, "routines")).includes("more routine") && (await requests(p, "routines")).map((r) => r.offset).join() === "0,3,6");
await p.close();
p = await open("palette=open&routinepage=3&src=routineschanged");
await type(p, "e");
await activate(p, "Show 3 more routines");
await p.keyboard.press("Enter");
await p.waitForTimeout(400);
check("R8 a later page with another revision and the same total: the list changed, the accepted page kept, and no more paging", (await groupText(p, "routines")).includes("The list of routines changed while more were loading. Search again to see it from the start.") && (await p.locator('.s-group[data-group="routines"] .s-row[data-kind="routine"]').count()) === 3 && !(await groupText(p, "routines")).includes("more routine") && !(await groupText(p, "routines")).includes("All 7") && (await requests(p, "routines")).map((r) => r.offset).join() === "0,3");
await p.close();
p = await open("palette=open&routinepage=3&src=routinesnorev");
await type(p, "e");
for (const more of ["Show 3 more routines", "Show 1 more routine"]) {
  await activate(p, more);
  await p.keyboard.press("Enter");
  await p.waitForTimeout(400);
}
check("R8 without a revision, the last page says how many loaded, never All", (await groupText(p, "routines")).includes("7 routine results loaded") && !(await groupText(p, "routines")).includes("All 7"));
await p.close();
p = await open("palette=open&routinepage=3&src=routinesmorefail");
await type(p, "e");
await activate(p, "Show 3 more routines");
await p.keyboard.press("Enter");
await p.waitForTimeout(400);
check("R8 a page that fails says so, with Try again", (await groupText(p, "routines")).includes("Couldn't load more routines: the gateway didn't answer in time."));
await activate(p, "Try again");
await p.keyboard.press("Enter");
await p.waitForTimeout(400);
check("R8 Try again loads that page", (await groupText(p, "routines")).includes("First 6 of 7"));
await p.close();
p = await open("palette=open&src=routinesfail");
await type(p, "tidy");
check("S10 routines failing say so", (await groupText(p, "routines")).includes("Couldn't search routines: the gateway refused the request."));
await p.close();

// Read-only, offline, keyboard, widths --------------------------------------------------------------------------------------------
const write = await open("palette=open&q=transcode");
await settle(write);
const ro = await open("palette=open&q=transcode&state=readonly");
await settle(ro);
check("S2 read-only: the same results and coverage", (await body(write)) === (await body(ro)));
await write.close();
await ro.close();

p = await open("palette=open&banner=offline&q=disk");
await settle(p);
check("S10 offline: the gateway's sources are not asked, and say so", (await groupText(p, "messages")).includes("Not searched: Home gateway isn't connected.") && (await groupText(p, "files")).includes("Not searched") && (await groupText(p, "routines")).includes("Not searched") && (await requests(p)).length === 0);
check("S10 offline: the device's sources still filter what was loaded", (await body(p)).includes("Disk almost full on the media box"));
await p.close();

p = await open("palette=open&q=backup");
await settle(p);
await p.keyboard.press("PageDown");
check("S12 Page Down goes to the next group's first option", (await activeText(p)).includes("Week 1: backup done"));
await p.keyboard.press("PageUp");
check("S12 Page Up goes back", (await activeText(p)).includes("Weekly backup check"));
check("S12 groups are named groups described by their coverage line", await p.evaluate(() => { const g = document.querySelector('.s-group[data-group="messages"]'); return g.getAttribute("role") === "group" && document.getElementById(g.getAttribute("aria-labelledby")).textContent.startsWith("Messages") && document.getElementById(g.getAttribute("aria-describedby")).textContent.includes("More indexed messages match"); }));
await p.close();

for (const [w, h] of [[1440, 900], [1100, 800], [800, 800], [390, 844]]) {
  p = await open(`palette=open&q=sizing${w === 390 ? "&width=phone" : ""}`, { width: w, height: h });
  await settle(p);
  const fits = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector(".s-palette").scrollWidth <= document.querySelector(".s-palette").clientWidth + 1);
  check(`S3 no sideways scroll at ${w}, long addresses included`, fits);
  if (w >= 800) check(`S3 the palette is 640 px wide at ${w}`, Math.round(await p.evaluate(() => document.querySelector(".s-palette").getBoundingClientRect().width)) === 640);
  await p.close();
}

await b.close();
console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("ok")).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
