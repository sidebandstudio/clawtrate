// Behaviour checks for search.html: opening the palette, what each source
// covers, the request rule's visible states, every way a result opens or cannot,
// "Search each bot for more", partial and failed groups, offline and read-only,
// the keyboard and roles, and the phone's scopes (docs/design/search.md).
// Run from the repository root:  node docs/design/prototype/tools/checks/search.mjs
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("search.html") + "?chrome=0&theme=light";
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
const settle = (p) => p.waitForTimeout(700);
const text = (p, sel) => p.evaluate((s) => document.querySelector(s)?.innerText || "", sel);
const body = (p) => text(p, "#s-body");
const paletteOpen = (p) => p.evaluate(() => !document.querySelector("#search-layer").hidden && Boolean(document.querySelector('.s-palette[role="dialog"]')));
const groupText = (p, id) => text(p, `.s-group[data-group="${id}"]`);
const activeText = (p) => p.evaluate(() => document.getElementById(document.querySelector("#s-field").getAttribute("aria-activedescendant"))?.innerText || "");
const type = async (p, q) => {
  await p.fill("#s-field", q);
  await settle(p);
};
const activate = async (p, label) => {
  // Move the active row to the option whose text includes `label`, with the arrow keys, then Enter.
  for (let i = 0; i < 80; i++) {
    if ((await activeText(p)).includes(label)) break;
    await p.keyboard.press("ArrowDown");
  }
  const at = await activeText(p);
  if (!at.includes(label)) throw new Error(`no option with "${label}"`);
};
const mod = async (p) => ((await p.evaluate(() => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent))) ? "Meta" : "Control");

process.on("uncaughtException", (e) => {
  console.log(out.join("\n"));
  console.log("THREW", e.message.split("\n")[0]);
  process.exit(1);
});

// Opening, before anything is typed, closing -------------------------------------------------------
let p = await open();
const button = p.locator('[data-action="search"]');
check("F-033 the rail's search button is named Search and says it opens a dialog", (await button.getAttribute("aria-label")) === "Search" && (await button.getAttribute("aria-haspopup")) === "dialog" && (await button.getAttribute("title")) === "Search (⌘K)");
await p.locator(".composer-input").focus().catch(() => {});
const K = await mod(p);
await p.keyboard.press(`${K}+k`);
await p.waitForTimeout(120);
check("F-033 Cmd/Ctrl+K opens the palette from the composer, focus in its field", (await paletteOpen(p)) && (await p.evaluate(() => document.activeElement.id === "s-field")));
check("S3 the palette is a modal dialog named Search; its field is a combobox for the result list", await p.evaluate(() => { const d = document.querySelector(".s-palette"); const f = document.querySelector("#s-field"); return d.getAttribute("aria-modal") === "true" && d.getAttribute("aria-label") === "Search" && f.getAttribute("role") === "combobox" && f.getAttribute("aria-controls") === "s-list" && f.getAttribute("aria-autocomplete") === "list"; }));
check("S3 the placeholder names every source", (await p.getAttribute("#s-field", "placeholder")) === "Search bots, tasks, messages, files, links, routines and settings");
const idle = await body(p);
check(
  "S4 before typing, what each source covers",
  idle.includes("What search looks in") &&
    idle.includes("Every bot, by name.") &&
    idle.includes("Task names in this device's task list.") &&
    idle.includes("Your messages and the bots' replies, in every bot's tasks. Not steps, tool results, reasoning or archived tasks.") &&
    idle.includes("File names in each bot's workspace.") &&
    idle.includes("Links in the conversations loaded on this device: 2 now.") &&
    idle.includes("Routines, by name and description.") &&
    idle.includes("Clawtrate's settings."),
);
check("S4 the coverage list is text, not options", await p.evaluate(() => !document.querySelector('#s-body [role="option"]') && document.querySelector("#s-field").getAttribute("aria-expanded") === "false"));
check("S3 the foot says the keys", (await text(p, ".s-foot")) === "↑↓ Move · ↵ Open · Esc Close");
await p.keyboard.press(`${K}+k`);
check("S3 Cmd/Ctrl+K with the palette open keeps it open", await paletteOpen(p));
await type(p, "transcode");
await p.keyboard.press("Tab");
check("S12 Tab stays in the field on the desktop", await p.evaluate(() => document.activeElement.id === "s-field"));
await p.keyboard.press("Escape");
check("S12 Escape closes the palette and returns focus to what had it", !(await paletteOpen(p)) && (await p.evaluate(() => document.activeElement.classList.contains("composer-input"))));
await button.click();
await p.waitForTimeout(120);
check("S2 the query is not kept: the palette opens empty again", (await p.inputValue("#s-field")) === "" && (await body(p)).includes("What search looks in"));
check("S2 the query is not written to the device's storage", await p.evaluate(() => !Object.keys(localStorage).some((k) => (localStorage.getItem(k) || "").includes("transcode"))));
await p.keyboard.press("Escape");
check("S12 Escape returns focus to the rail's button", await p.evaluate(() => document.activeElement.dataset.action === "search"));
await p.evaluate(() => { const d = document.createElement("dialog"); d.id = "other"; document.body.append(d); d.showModal(); });
await p.keyboard.press(`${K}+k`);
check("S3 Cmd/Ctrl+K does nothing while another modal dialog is open", !(await paletteOpen(p)));
await p.close();

// Messages: all matches, opening one in place -----------------------------------------------------
p = await open("palette=open");
await type(p, "transcode");
const msgs = await groupText(p, "messages");
check("F-033 messages: the coverage line says all were returned, newest first", msgs.includes("Messages · 3") && msgs.includes("All 3 matching messages, newest first"));
check("F-033 messages are newest first", await p.evaluate(() => { const t = [...document.querySelectorAll('.s-group[data-group="messages"] .s-time')].map((x) => x.textContent); return t.join() === "5:37 PM,5:36 PM,5:33 PM"; }));
check("S7 a snippet marks the matched words by weight", await p.evaluate(() => [...document.querySelectorAll('.s-group[data-group="messages"] b')].some((x) => x.textContent === "transcode")));
const files = await groupText(p, "files");
check("S10 files searched in part keep their own lines, not 'no match'", files.includes("No match in the workspaces of Juniper, Otto and Pip.") && files.includes("Not searched: Marlow, none of whose tasks works in its workspace."));
const nomatch = await text(p, ".s-nomatch");
check("S10 'No match in' names only groups searched in full", nomatch === "No match in Bots, Tasks, Links, Routines and Settings.", nomatch);
check("S12 the first option is active and named for where it leads", (await p.evaluate(() => document.getElementById(document.querySelector("#s-field").getAttribute("aria-activedescendant"))?.getAttribute("aria-label"))).startsWith("Message in Disk almost full on the media box, from Otto"));
check("S7 the active row says what Enter does", (await activeText(p)).includes("Go to message"));
await p.keyboard.press("ArrowDown");
check("S12 Down moves the active row", (await activeText(p)).includes("Yes, clear the transcode cache."));
await p.waitForTimeout(450);
check("S12 the live region says what came back", (await text(p, "#s-live")).includes("3 results: 3 messages."));
await p.keyboard.press("Enter");
await p.waitForTimeout(80);
check("S9 a message opens its task behind the palette, which says Opening…", (await paletteOpen(p)) && (await body(p)).includes("Opening…"));
await p.waitForTimeout(400);
check("F-033 the message is in the loaded rows: the palette closes, the task is open", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".task-line")?.textContent === "Disk almost full on the media box")));
check("S9 the message is marked with the ring and its turn has focus", await p.evaluate(() => { const hit = document.querySelector(".bubble.search-hit"); return hit && hit.textContent.includes("Yes, clear the transcode cache.") && document.activeElement === hit.closest(".turn"); }));
await p.waitForTimeout(80);
check("S9 the app announces where it opened", (await text(p, "#search-announce")).startsWith("Opened Disk almost full on the media box, at your message of"));
await p.waitForTimeout(2600);
check("S9 the ring fades after 2 seconds", await p.evaluate(() => !document.querySelector(".bubble.search-hit")));
await p.close();

p = await open("palette=open&motion=reduce");
await type(p, "transcode");
await p.keyboard.press("Enter");
await p.waitForTimeout(500);
await p.waitForTimeout(2600);
check("S9 with reduced motion the ring stays until the next key", await p.evaluate(() => Boolean(document.querySelector(".bubble.search-hit"))));
await p.keyboard.press("Shift");
await p.waitForTimeout(80);
check("S9 the next key removes it", await p.evaluate(() => !document.querySelector(".bubble.search-hit")));
await p.close();

// More matches than 25: search each bot -------------------------------------------------------------
p = await open("palette=open");
await type(p, "backup");
let m = await groupText(p, "messages");
check("F-268 truncated: the 25 best matches across all bots, and more match", m.includes("Messages · 25") && m.includes("The gateway's 25 best matches across all bots, newest first. More messages match."));
check("F-268 never 'recent' and never 'Search older'", !(await body(p)).includes("Search older") && !(await body(p)).toLowerCase().includes("recent messages"));
check("S7 a group shows 5 rows, then Show all", (await p.locator('.s-group[data-group="messages"] .s-row[data-kind="message"]').count()) === 5 && m.includes("Show all 25 messages"));
await activate(p, "Show all 25 messages");
await p.keyboard.press("Enter");
check("S7 Show all shows the rest in place", (await p.locator('.s-group[data-group="messages"] .s-row[data-kind="message"]').count()) === 25);
check("F-268 the 25 came from one bot here; the others were left out", await p.evaluate(() => [...document.querySelectorAll('.s-group[data-group="messages"] .s-title')].every((x) => x.textContent === "Weekly backup check")));
await activate(p, "Search each bot for more");
await p.keyboard.press("Enter");
await p.waitForTimeout(400);
m = await groupText(p, "messages");
check(
  "F-268 search each bot: one line per bot, saying what was searched",
  m.includes("Searched each bot, up to 25 matches from each") &&
    m.includes("Juniper · no matches") &&
    m.includes("Marlow · all 2 matches") &&
    m.includes("Otto · 25 best matches. More match; add words to narrow them.") &&
    m.includes("Pip · all 3 matches"),
);
check("F-268 it finds what the first search left out", m.includes("Saved a backup copy as the March draft") || (await p.locator('.s-group[data-group="messages"] .s-row', { hasText: "Here is the week" }).count()) > 0);
await p.waitForTimeout(450);
check("S12 the live region says each bot was searched", (await text(p, "#s-live")).startsWith("Searched each of 4 bots:"));
// A message older than the loaded 200 rows.
await type(p, "backup");
await activate(p, "Week 1: backup done");
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S9 an older match: the palette stays and says it can't be shown in place", (await paletteOpen(p)) && (await body(p)).includes("This message is earlier than the 200 messages a conversation shows, so it can't be shown in place."));
check("S9 the task is already open behind the palette", await p.evaluate(() => document.querySelector(".task-line")?.textContent === "Weekly backup check"));
await activate(p, "Open the task at its latest");
await p.keyboard.press("Enter");
check("S9 Open the task at its latest closes the palette on that task", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".task-line")?.textContent === "Weekly backup check")));
await p.close();

p = await open("palette=open&q=backup&each=1&src=eachfail");
await settle(p);
m = await groupText(p, "messages");
check("S8 a bot whose search fails says so, with Try again for it", m.includes("Pip · couldn't search: the gateway didn't answer in time") && m.includes("Try again for Pip"));
await activate(p, "Try again for Pip");
await p.keyboard.press("Enter");
check("S8 Try again searches that bot again", (await groupText(p, "messages")).includes("Pip · all 3 matches"));
await p.close();

// Task names and links ---------------------------------------------------------------------------------
p = await open("palette=open");
await type(p, "heat");
const tasks = await groupText(p, "tasks");
check("S5 task names are matched on the device", tasks.includes("Heat pump vs. gas furnace") && tasks.includes("By name, in this device's task list"));
const links = await groupText(p, "links");
check("F-033 links say they come only from conversations this device has loaded", links.includes("Only from the 2 conversations this device has loaded") && links.includes("energy.example"));
await activate(p, "sizing-guide");
check("S3 a link row adds Shift+Enter to the foot", (await text(p, ".s-foot")).includes("⇧↵ Open in browser"));
await p.keyboard.press("Shift+Enter");
await p.waitForTimeout(80);
const conf = await text(p, ".s-confirm");
check("S9 Shift+Enter on a link: the confirmation with the full address, host first", conf.includes("energy.example/heat-pumps/sizing-guide") && conf.includes("Opens in your browser.") && (await p.evaluate(() => document.querySelector(".s-confirm-address b").textContent === "energy.example" && document.querySelector(".s-confirm").getAttribute("role") === "alertdialog")));
await p.keyboard.press("Escape");
check("S12 Escape closes the confirmation first, not the palette", (await paletteOpen(p)) && !(await p.evaluate(() => document.querySelector(".s-confirm"))));
await type(p, "127.0.0.1");
await activate(p, "127.0.0.1");
await p.keyboard.press("Shift+Enter");
check("S9 an address on this computer says so", (await text(p, ".s-confirm")).includes("This address is on this computer."));
await p.click('[data-s="confirm-open"]');
await p.waitForTimeout(80);
check("S9 Open leaves the app (in the app) and closes the palette", !(await paletteOpen(p)) && (await text(p, "#search-announce")).includes("opens in your browser"));
await p.keyboard.press(`${K}+k`);
await type(p, "rebates");
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S9 Enter on a link goes to the message that holds it", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".task-line")?.textContent === "Heat pump vs. gas furnace" && Boolean(document.querySelector(".bubble.search-hit")))));
await p.close();

p = await open("palette=open&links=none");
check("S4 with no conversation loaded, the links line says so", (await body(p)).includes("Links in conversations you open. None is loaded now."));
await type(p, "energy");
const noneLinks = await text(p, ".s-none");
check("S7 links with nothing loaded say so, never 'no match'", noneLinks.includes("Links") && noneLinks.includes("No conversation is loaded on this device yet") && !noneLinks.includes("Links in the 0"));
await p.close();

// Routines, settings, files, bots -----------------------------------------------------------------------
p = await open("palette=open");
await type(p, "tide");
const routines = await groupText(p, "routines");
check("F-033 routines by name and description, on or off", routines.includes("By name and description") && routines.includes("Weekday tide digest") && routines.includes("Pip · Off"));
check("S9 a routine row says it opens its bot", (await activeText(p)).includes("Open Pip"));
await p.keyboard.press("Enter");
check("S9 a routine opens its bot", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".title-pill-name")?.textContent === "Pip")));
await p.keyboard.press(`${K}+k`);
await type(p, "ott");
check("S5 bots by name", (await groupText(p, "bots")).includes("Otto"));
await p.keyboard.press("Enter");
check("S9 a bot opens as its row does", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".title-pill-name")?.textContent === "Otto")));
await p.keyboard.press(`${K}+k`);
await type(p, "t");
check("S6 files ask for 2 characters", (await groupText(p, "files")).includes("Type 2 or more characters to search file names."));
await type(p, "md");
const f2 = await groupText(p, "files");
check("F-033 files: names in the workspaces searched, and who was not searched", f2.includes("Names in the workspaces of Juniper, Otto and Pip") && f2.includes("Not searched: Marlow") && f2.includes("disk-2026-11-16.md"));
await activate(p, "disk-2026-11-16.md");
await p.keyboard.press("Enter");
await p.waitForURL(/work\.html/);
await p.waitForTimeout(250);
check("S9 a file opens in the Work pane's reader", p.url().includes("file=notes%2Fdisk-2026-11-16.md") && (await p.evaluate(() => document.querySelector(".shell").dataset.panel === "open")));
await p.goto(base + "&palette=open");
await type(p, "acc");
await p.keyboard.press("Enter");
await p.waitForURL(/controls\.html/);
await p.waitForTimeout(250);
check("S9 a setting opens Settings at its section", p.url().includes("section=accounts") && (await p.evaluate(() => [...document.querySelectorAll("dialog")].some((d) => d.open))));
await p.close();

// Nothing found, failures, partial ------------------------------------------------------------------------
p = await open("palette=open");
await type(p, "ephyr");
const none = await body(p);
check("S10 no match anywhere: the title, and what each source searched", none.includes("No results for “ephyr”") && none.includes("Messages match whole words; the last word may be the start of one.") && none.includes("No match in the workspaces of Juniper, Otto and Pip. Not searched: Marlow"));
await p.waitForTimeout(450);
check("S12 the live region says no results", (await text(p, "#s-live")) === "No results for ephyr.");
await p.close();

p = await open("palette=open&src=msgfail&q=transcode");
await settle(p);
check("S10 a failed source: its line in the danger tone, the others unaffected, and no 'No results' title", (await groupText(p, "messages")).includes("Couldn't search messages: the gateway didn't answer in time.") && (await p.evaluate(() => document.querySelector('.s-group[data-group="messages"]').dataset.tone === "danger")) && (await text(p, ".s-nomatch")).includes("Routines") && !(await body(p)).includes("No results for"));
await activate(p, "Try again");
await p.keyboard.press("Enter");
await p.waitForTimeout(300);
check("S10 Try again asks that source again", (await groupText(p, "messages")).includes("All 3 matching messages"));
await p.close();

p = await open("palette=open&src=filesfail&q=md");
await settle(p);
const ff = await groupText(p, "files");
check("S7 files fail per bot, with Try again for that bot", ff.includes("Pip: couldn't search files: the gateway refused the request.") && ff.includes("Try again for Pip"));
await activate(p, "Try again for Pip");
await p.keyboard.press("Enter");
await p.waitForTimeout(100);
const fr = await groupText(p, "files");
check("S7 Try again for Pip searches its files", fr.includes("Names in the workspaces of Juniper, Otto and Pip") && !fr.includes("couldn't search"));
await p.close();

p = await open("palette=open&src=routinesfail&q=tide");
await settle(p);
check("S10 routines failing say so", (await groupText(p, "routines")).includes("Couldn't search routines: the gateway refused the request."));
await p.close();

p = await open("palette=open&src=indexing&q=transcode");
await settle(p);
check("S8 indexing is said", (await groupText(p, "messages")).includes("The gateway is still indexing some messages, so recent ones may be missing."));
await p.close();
p = await open("palette=open&src=archive&q=transcode");
await settle(p);
check("S8 the archive count is said", (await groupText(p, "messages")).includes("4 tasks' older messages are in the gateway's archive and weren't searched."));
await p.close();
p = await open("palette=open&src=slow&q=transcode");
await settle(p);
check("S10 a source that has not answered says Searching…, with skeleton rows", (await groupText(p, "messages")).includes("Searching…") && (await p.locator('.s-group[data-group="messages"] .s-skeleton').count()) === 1 && !(await body(p)).includes("No results"));
await p.close();

p = await open("palette=open&banner=offline&q=disk");
await settle(p);
const off = await body(p);
check("S10 offline: the gateway's groups are not searched, and say so", (await groupText(p, "messages")).includes("Not searched: Home gateway isn't connected. Search runs again when it reconnects.") && (await groupText(p, "files")).includes("Not searched") && (await groupText(p, "routines")).includes("Not searched"));
check("S10 offline: the device's groups still filter what was loaded", off.includes("Disk almost full on the media box"));
await p.close();

p = await open("palette=open&state=partial");
check("S4 a task list cut short is said", (await body(p)).includes("which holds the most recent tasks only"));
await p.close();

const write = await open("palette=open&q=transcode");
await settle(write);
const ro = await open("palette=open&q=transcode&state=readonly");
await settle(ro);
check("S2 read-only: the same results and coverage", (await body(write)) === (await body(ro)));
await write.close();
await ro.close();

// When a result cannot open -----------------------------------------------------------------------------------
p = await open("palette=open&q=transcode&gone=task");
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(100);
check("S9 a task deleted after the search: the palette stays and says so", (await paletteOpen(p)) && (await body(p)).includes("This task is no longer on the gateway's list: it was archived or deleted."));
await p.close();
p = await open("palette=open&q=transcode&gone=unlisted");
await settle(p);
const un = await groupText(p, "messages");
check("S9 a task the device's list does not hold: its title from the search, and why it can't open", un.includes("Old transcode settings") && un.includes("This task isn't in this device's task list, which holds the newest 500 tasks."));
await activate(p, "Old transcode settings");
check("S9 its active row says Can't open", (await activeText(p)).includes("Can't open"));
await p.keyboard.press("Enter");
check("S9 Enter does not open it", await paletteOpen(p));
await p.close();
p = await open("palette=open&q=transcode&gone=bot");
await settle(p);
check("S9 a deleted bot's results say so", (await groupText(p, "messages")).includes("Otto is no longer on this gateway."));
await p.close();
p = await open("palette=open&q=transcode&older=1");
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S9 older=1: the match is earlier than the loaded rows", (await body(p)).includes("This message is earlier than the 200 messages"));
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

// Keyboard: groups ------------------------------------------------------------------------------------------
p = await open("palette=open&q=backup");
await settle(p);
await p.keyboard.press("PageDown");
check("S12 Page Down goes to the next group's first option", (await activeText(p)).includes("Week 1: backup done"));
await p.keyboard.press("PageDown");
check("S12 and on to the next group", (await activeText(p)).includes("Monday backup report"));
await p.keyboard.press("PageUp");
check("S12 Page Up goes back", (await activeText(p)).includes("Week 1: backup done"));
check("S12 groups are named groups described by their coverage line", await p.evaluate(() => { const g = document.querySelector('.s-group[data-group="messages"]'); return g.getAttribute("role") === "group" && document.getElementById(g.getAttribute("aria-labelledby")).textContent.startsWith("Messages") && document.getElementById(g.getAttribute("aria-describedby")).textContent.includes("25 best matches"); }));
await p.close();

// Widths ----------------------------------------------------------------------------------------------------
for (const [w, h] of [[1100, 800], [800, 800], [390, 844]]) {
  p = await open("palette=open&q=backup", { width: w, height: h });
  await settle(p);
  const fits = await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector(".s-palette").scrollWidth <= document.querySelector(".s-palette").clientWidth + 1);
  check(`S3 no sideways scroll at ${w}`, fits);
  if (w >= 800) check(`S3 the palette is 640 px wide at ${w}`, Math.round(await p.evaluate(() => document.querySelector(".s-palette").getBoundingClientRect().width)) === 640);
  await p.close();
}

// The phone: scopes ------------------------------------------------------------------------------------------
p = await open("palette=open&q=backup&width=phone", { width: 390, height: 844 });
await settle(p);
const scopes = await p.evaluate(() => [...document.querySelectorAll('.s-scopes [role="tab"]')].map((t) => t.textContent));
check("F-240 the phone has the scopes All, Messages, Bots, Group Chats, Files and Routines", scopes.join() === "All,Messages,Bots,Group Chats,Files,Routines", scopes.join());
check("F-240 All is chosen first; the search is a full screen with Cancel", (await p.evaluate(() => document.querySelector('[data-scope="all"]').getAttribute("aria-selected") === "true" && document.querySelector(".s-cancel").offsetParent !== null)) && (await p.getAttribute("#s-field", "placeholder")) === "Search");
check("S11 All shows 3 rows a group, then See all", (await p.locator('.s-group[data-group="messages"] .s-row[data-kind="message"]').count()) === 3 && (await groupText(p, "messages")).includes("See all 25 messages"));
check("S11 coverage lines and Search each bot are the same on the phone", (await groupText(p, "messages")).includes("More messages match.") && (await groupText(p, "messages")).includes("Search each bot for more"));
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
check("S12 End goes to the last scope", await p.evaluate(() => document.activeElement.dataset.scope === "routines"));
check("F-240 Routines shows its group", (await body(p)).includes("Monday backup report"));
await p.keyboard.press("Home");
await p.click(".s-cancel");
check("S11 Cancel closes search", !(await paletteOpen(p)));
await p.close();

p = await open("palette=open&q=transcode&width=phone", { width: 390, height: 844 });
await settle(p);
await p.keyboard.press("Enter");
await p.waitForTimeout(450);
check("S11 on the phone, opening a result closes search and shows the conversation", !(await paletteOpen(p)) && (await p.evaluate(() => document.querySelector(".shell").dataset.view === "detail" && Boolean(document.querySelector(".bubble.search-hit")))));
await p.close();

p = await open("palette=open&width=phone&theme=dark", { width: 390, height: 844 });
check("S11 the phone's coverage list stacks", (await body(p)).includes("What search looks in"));
await p.close();

await b.close();
console.log(out.join("\n"));
console.log(`\n${out.filter((l) => l.startsWith("ok")).length} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
