// Behaviour checks for the Library and Pages (library.html), docs/design/library.md.
// Run from the repository root:  node docs/design/prototype/tools/checks/library.mjs
import { readFile } from "node:fs/promises";
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("library.html") + "?chrome=0&theme=light&bot=marlow&task=m2";
const lib = "&panel=open&tab=library";
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
let outside = []; // requests that left the page's own files
const open = async (query = "", viewport = { width: 1440, height: 900 }, options = {}) => {
  const p = await b.newPage({ viewport, acceptDownloads: true, ...options });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  p.on("request", (r) => {
    const u = r.url();
    if (!/^(file|data|about|blob):/.test(u)) outside.push(u);
  });
  await p.goto(base + query);
  await p.waitForTimeout(150);
  return p;
};
const q = (p, fn, arg) => p.evaluate(fn, arg);
const text = (p, sel) => q(p, (s) => document.querySelector(s)?.innerText ?? null, sel);
const announced = async (p) => (await p.waitForTimeout(80), q(p, () => document.querySelector("#announcer")?.textContent ?? ""));
const subOf = (p, id) => q(p, (i) => document.querySelector(`.lib-row[data-item="${i}"] .file-sub`)?.textContent, id);

// The tab and what it reads -------------------------------------------------------------------------

let p = await open(lib);
check("F-208 the pane's tab bar: Details, Files, Library, Computer, Settings", await q(p, () => [...document.querySelectorAll(".tabs .tab")].map((x) => x.textContent.trim()).join() === "Details,Files,Library,Computer,Settings"));
check("F-208 the freshness line says which tasks were searched", (await text(p, "#lib-fresh span")) === "In Marlow's 10 most recent tasks of 12 · checked 5:41 PM");
check("F-208 groups Today, This week, Older and Time not read, in that order", await q(p, () => [...document.querySelectorAll(".lib-group h3")].map((h) => h.textContent).join() === "Today,This week,Older,Time not read"));
check("F-208 Time not read says why", (await text(p, '.lib-group[data-group="unread"] .lib-group-note')) === "These are in long tasks, beyond the messages read.");
check("F-208 five rows a group, then Show 4 more", await q(p, () => document.querySelectorAll('.lib-group[data-group="today"] .lib-row').length === 5 && document.querySelector('[data-lib-more="today"]').textContent === "Show 4 more"));
check("F-208 newest first: the later Trail guide, then the report", await q(p, () => [...document.querySelectorAll('.lib-group[data-group="today"] .lib-row')].slice(0, 2).map((r) => r.dataset.item).join() === "p2,i5"));
check("F-208 a row's second line: type, time, task", (await subOf(p, "p2")) === "Page · 5:37 PM · Saturday's trail plan");
check("F-209 the earlier card of the same page reads Shown again below", (await subOf(p, "p1")) === "Page · 5:33 PM · Shown again below · Saturday's trail plan");
check("F-208 a link's row names its host", (await subOf(p, "k1")) === "trails.example · 5:34 PM · Saturday's trail plan");
check("F-208 nothing claims a total of the bot's items", await q(p, () => !/\bof \d+ items|\d+ items in total/i.test(document.querySelector("#panel-library").innerText)));
await p.click('[data-lib-more="today"]');
check("Show more reveals the rest; focus moves to the last row", await q(p, () => document.querySelectorAll('.lib-group[data-group="today"] .lib-row').length === 9 && !document.querySelector('[data-lib-more="today"]') && document.activeElement.dataset.libOpen === document.querySelectorAll('.lib-group[data-group="today"] [data-lib-open]')[8].dataset.libOpen));
check("before looking further, Old trail notes is not listed", await q(p, () => !document.querySelector('.lib-row[data-item="i12"]')));
await p.click('[data-lib="look"]');
check("F-208 Look in 2 more tasks: every task read, the line says so, the foot is gone", (await text(p, "#lib-fresh span")) === "In all 12 of Marlow's tasks · checked 5:41 PM" && (await q(p, () => !document.querySelector('[data-lib="look"]') && Boolean(document.querySelector('.lib-row[data-item="i12"]')))));
check("…and it is announced", (await announced(p)).includes("Looked in 12 of Marlow's 12 tasks"));
await p.close();

// Filters -------------------------------------------------------------------------------------------

p = await open(lib);
check("F-208 the filters: All, Pages, Media, Links, Files, Pinned; no Apps", await q(p, () => [...document.querySelectorAll(".lib-filter")].map((x) => x.textContent).join() === "All,Pages,Media,Links,Files,Pinned" && document.querySelector(".lib-filters").getAttribute("role") === "radiogroup"));
await p.focus('[data-lib-filter="all"]');
await p.keyboard.press("ArrowRight");
check("arrows move and choose: Pages lists only pages", await q(p, () => document.activeElement.dataset.libFilter === "pages" && [...document.querySelectorAll(".lib-row")].every((r) => r.dataset.kind === "page") && document.querySelectorAll(".lib-row").length === 3));
await p.click('[data-lib-filter="media"]');
check("Media: pictures, recordings and videos", await q(p, () => [...document.querySelectorAll(".lib-row")].every((r) => ["image", "audio", "video"].includes(r.dataset.kind))));
await p.click('[data-lib-filter="links"]');
check("Links: only links", await q(p, () => [...document.querySelectorAll(".lib-row")].every((r) => r.dataset.kind === "link") && document.querySelectorAll(".lib-row").length === 3));
await p.click('[data-lib-filter="files"]');
check("Files: only files", await q(p, () => [...document.querySelectorAll(".lib-row")].every((r) => r.dataset.kind === "file")));
await p.click('[data-lib-filter="pinned"]');
check("F-208 Pinned lists the pins, newest pin first", await q(p, () => [...document.querySelectorAll(".lib-row")].map((r) => r.dataset.item).join() === "p2,k3,gone:m11"));
check("a pin whose message is gone says so, with Unpin", (await text(p, '.lib-row[data-gone="true"] .file-name')) === "Not found in Old trail notes any more" && (await text(p, ".lib-unpin")) === "Unpin");
await p.close();

// States of the tab ---------------------------------------------------------------------------------

p = await open(lib + "&lib=loading");
check("loading: skeleton rows, busy, and the line says it is looking", await q(p, () => Boolean(document.querySelector('#panel-library [aria-busy="true"]')) && document.querySelectorAll("#panel-library .skeleton-row").length === 5) && (await text(p, "#panel-library .files-fresh span")) === "Looking in Marlow's tasks…");
await p.close();
p = await open(lib + "&lib=partial");
check("some tasks couldn't be read: the line says how many, rows of the others stay", (await text(p, ".lib-failed span")) === "Couldn't read 2 of the 10 tasks." && (await q(p, () => !document.querySelector('.lib-row[data-item="i9"]') && Boolean(document.querySelector('.lib-row[data-item="p2"]')))));
await p.click('.lib-failed [data-lib="retry"]');
check("…Try again reads them: the line goes, their rows come", await q(p, () => !document.querySelector(".lib-failed") && Boolean(document.querySelector('.lib-row[data-item="i9"]'))));
await p.close();
p = await open(lib + "&lib=error");
check("nothing could be read: the reason and Try again", (await text(p, ".work-empty h4")) === "Couldn't load Marlow's library" && (await text(p, ".work-empty p")) === "The gateway did not answer.");
await p.close();
p = await open(lib + "&lib=empty");
check("empty: Nothing found yet, and the line says what was searched", (await text(p, ".work-empty h4")) === "Nothing found yet" && (await text(p, ".work-empty p")) === "Pages, pictures, files and links Marlow sends appear here." && (await text(p, "#lib-fresh span")).startsWith("In Marlow's 10 most recent tasks of 12"));
await p.click('[data-lib-filter="pages"]');
check("empty under a filter: No pages in these tasks, and Look in more tasks", (await text(p, ".work-empty h4")) === "No pages in these tasks." && (await q(p, () => Boolean(document.querySelector('[data-lib="look"]')))));
await p.close();
p = await open(lib + "&lib=offline");
check("connection lost: rows keep their look, the line says so, no Refresh", (await text(p, "#lib-fresh span")) === "Can't reach the gateway · checked 5:41 PM" && (await q(p, () => !document.querySelector('[data-lib="refresh"]') && document.querySelectorAll(".lib-row").length > 0)));
await p.close();

// Pins ----------------------------------------------------------------------------------------------

p = await open(lib);
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
check("F-208 Pin: busy until the gateway's preferences are read back", await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-busy") === "true" && !document.querySelector('.lib-row[data-item="i5"] .lib-pinmark')));
await p.waitForTimeout(450);
check("…then the mark, pressed, and Pinned announced", (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "true" && Boolean(document.querySelector('.lib-row[data-item="i5"] .lib-pinmark')))) && (await announced(p)).includes("Pinned trail-report.md"));
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("Unpin the same way", (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false")) && (await announced(p)).includes("Unpinned trail-report.md"));
await p.close();
p = await open(lib + "&filter=pinned", { width: 1440, height: 900 });
await q(p, () => {
  const list = window.CT.library.L.pins.marlow;
  list.unshift("i8");
  window.CT.library.rerender();
  window.CT.announce("Pins changed on another device");
});
check("another device's change: the list follows it and it is announced", (await q(p, () => document.querySelector(".lib-row").dataset.item === "i8")) && (await announced(p)).includes("Pins changed on another device"));
await p.close();
for (const [fail, words] of [
  ["conflict", "Couldn't pin: pins changed on another device. Try again."],
  ["noanswer", "Couldn't pin: no answer from the gateway."],
]) {
  p = await open(lib + `&pinfail=${fail}`);
  await p.hover('.lib-row[data-item="i5"]');
  await p.click('[data-lib-pin="i5"]');
  await p.waitForTimeout(450);
  check(`a pin refused (${fail}): not shown as pinned, and why`, (await text(p, ".lib-failed span")) === words && (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false")));
  await p.close();
}
p = await open(lib + "&pins=full");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
check("pins full: nothing sent, and how to make room", (await text(p, ".lib-failed span")) === "Marlow's pins are full. Unpin one to pin this.");
await p.close();
p = await open(lib + "&pinfail=limit");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("the profile's 128 settings used: says so", (await text(p, ".lib-failed span")) === "Couldn't pin: the gateway keeps at most 128 of your settings, and they are used.");
await p.close();
p = await open(lib + "&pins=none&filter=pinned");
check("nothing pinned: says where pins are kept", (await text(p, "#panel-library .work-empty h4")) === "Nothing pinned" && (await text(p, "#panel-library .work-empty p")) === "Pin an item to keep it here. Pins are kept on the gateway for every device you use.");
await p.close();
p = await open(lib + "&pins=device&filter=pinned");
check("no preferences for this connection: pins kept on this device, and the list says so", (await text(p, "#lib-pin-where")) === "Kept on this device only: the gateway keeps no preferences for this connection.");
await p.close();
p = await open(lib + "&state=readonly");
check("read-only: pins as the gateway keeps them are shown", await q(p, () => document.querySelector('[data-lib-pin="p2"]').getAttribute("aria-pressed") === "true"));
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
check("read-only: Pin gives the access bar, nothing pinned", (await text(p, ".lib-access .shelf-text")) === "Read-only. Pinning needs permission to change things on the gateway." && (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false" && document.activeElement.dataset.lib === "request-access")));
await p.click('[data-lib="request-access"]');
check("…Request access: Asking the gateway…", (await text(p, ".lib-access .shelf-text")) === "Asking the gateway…");
await p.waitForTimeout(400);
check("…then waiting for the owner, with the command", (await text(p, ".lib-access .shelf-text")).startsWith("Waiting for the gateway's owner.") && (await text(p, ".lib-access code")) === "openclaw devices approve 7c41d09e");
await p.close();

// Opening items -------------------------------------------------------------------------------------

p = await open(lib);
await p.click('[data-lib-filter="media"]');
await p.click('[data-lib-open="i2"]');
check("a picture opens the media viewer", await q(p, () => document.querySelector(".viewer")?.getAttribute("aria-label")?.startsWith("ridge-profile.png")));
await p.keyboard.press("Escape");
await p.click('[data-lib-filter="files"]');
await p.click('[data-lib-open="i7"]');
await p.waitForTimeout(400);
check("a file opens its task and the item in Files", await q(p, () => window.app.model.selectedTask === "m3" && !document.querySelector("#panel-files").hidden && document.querySelector("#panel-files").innerText.includes("packing.csv")));
await p.close();
p = await open(lib + "&filter=links");
await p.click('[data-lib-open="k1"]');
check("a link: the confirmation, host first, the full address, Opens in your browser", (await text(p, ".lib-confirm h2")) === "trails.example" && (await text(p, ".confirm-address")) === "https://trails.example/conditions" && (await q(p, () => document.querySelector(".lib-confirm").innerText.includes("Opens in your browser."))));
await p.keyboard.press("Escape");
check("…Escape cancels, focus back on the row", await q(p, () => !document.querySelector(".lib-confirm") && document.activeElement.dataset.libOpen === "k1"));
await p.close();

// The Page, full window -----------------------------------------------------------------------------

outside = [];
p = await open(lib + "&filter=pages");
await p.click('[data-lib-open="p2"]');
check("F-209 a Page opens full window, a dialog named by its title, focus on Close", await q(p, () => document.querySelector(".page-view")?.getAttribute("role") === "dialog" && document.querySelector("#page-title").textContent === "Trail guide" && document.activeElement.dataset.pv === "close"));
check("…loading first", await q(p, () => document.querySelector("#page-stage").getAttribute("aria-busy") === "true" && document.querySelector(".page-state").textContent === "Loading Trail guide…"));
await p.waitForTimeout(450);
check("F-209 the bar: type, bot, task and time", (await text(p, ".page-title span")) === "Page · Marlow · Saturday's trail plan · 5:37 PM");
check("the note says what is not shown and that controls change only this view", (await text(p, "#page-note-text")) === "Shown without its 3 scripts. Parts that need them don't work here. Links aren't followed here. Checkboxes, menus and folded sections change only this view.");
const srcdoc = await q(p, () => document.querySelector(".page-frame").getAttribute("srcdoc"));
const sandbox = await q(p, () => document.querySelector(".page-frame").getAttribute("sandbox"));
check("the frame: sandbox with no permissions, no script, no link, no address left, the policy first", sandbox === "" && !/<script|<a[\s>]|\shref=|https?:\/\//i.test(srcdoc.replace(/default-src[^"]*"/, "")) && /<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'/.test(srcdoc));
const frame = p.frames().find((f) => f.url() === "about:srcdoc");
await frame.click("text=park's conditions page");
await frame.check("#dry");
await frame.selectOption("#sort", "Climb");
await frame.click("summary");
await p.waitForTimeout(300);
check("F-374 a checkbox, a menu and a folded section change the view", (await frame.isChecked("#dry")) && (await frame.inputValue("#sort")) === "Climb" && (await frame.getAttribute("details", "open")) !== null);
check("a link's words stay as plain text, and a click on them leaves the Page in place", (await frame.evaluate(() => !document.querySelector("a") && [...document.querySelectorAll("span")].some((s) => s.textContent === "park's conditions page"))) && p.frames().some((f) => f.url() === "about:srcdoc") && (await frame.isChecked("#dry")));
await p.click('[data-pv="links"]');
check("Links (2): the full addresses, unabridged", await q(p, () => [...document.querySelectorAll(".page-links .menu-item")].map((x) => x.textContent).join() === "https://trails.example/conditions,https://maps.example/ridge"));
await p.keyboard.press("Escape");
check("…Escape closes the menu, focus back on Links", await q(p, () => !document.querySelector(".page-links") && document.activeElement.dataset.pv === "links"));
check("the chat is the task's, its field holds what will be sent", (await text(p, ".page-chat-head strong")) === "Saturday's trail plan" && (await q(p, () => document.querySelector("#page-chat-input").value === "About the page “Trail guide”: ")));
await p.click("#page-chat-input");
await p.keyboard.press("End");
await p.keyboard.type("is the ridge path open?");
await p.click('[data-pv="send"]');
check("F-209 sending from the side chat puts the message in the task's conversation", await q(p, () => document.querySelector('#page-chat-log [data-sent="true"]').textContent === "About the page “Trail guide”: is the ridge path open?"));
await p.focus('[data-pv="close"]');
await p.keyboard.press("Escape");
check("Escape closes the Page; focus returns to the row", await q(p, () => !document.querySelector(".page-view") && document.activeElement.dataset.libOpen === "p2"));
await p.click('[data-lib-open="p2"]');
await p.waitForTimeout(450);
const again = p.frames().find((f) => f.url() === "about:srcdoc");
check("F-374 opened again, the Page is as the bot left it", !(await again.isChecked("#dry")) && (await again.inputValue("#sort")) === "Distance");
check("a Page made no request on load or on any interaction", outside.length === 0, outside.join(" "));
await p.close();

p = await open(lib + "&page=packing-list");
await p.waitForTimeout(500);
check("a Page without scripts or links: the note has only its last sentence", (await text(p, "#page-note-text")) === "Checkboxes, menus and folded sections change only this view." && (await q(p, () => !document.querySelector('[data-pv="links"]'))));
await p.close();

p = await open("&page=trail-guide-1");
await p.waitForTimeout(500);
check("F-209 the earlier card's Page opens the same Page as it is now", (await text(p, ".page-title span")) === "Page · Marlow · Saturday's trail plan · 5:33 PM" && (await q(p, () => /forest track/i.test(document.querySelector(".page-frame").getAttribute("srcdoc")))));
await p.close();

p = await open("&page=trail-guide&pageload=failed");
await p.waitForTimeout(500);
check("the gateway refused: its words, Try again, and nothing to export", (await text(p, ".page-state p:nth-child(2)")) === "The gateway said: Canvas widget unavailable; reload the chat or ask the agent to recreate it." && (await q(p, () => document.querySelector('[data-pv="export"]').disabled)));
await p.click('[data-pv="retry"]');
await p.waitForTimeout(500);
check("…Try again shows the Page", await q(p, () => Boolean(document.querySelector(".page-frame")) && !document.querySelector('[data-pv="export"]').disabled));
await p.close();
p = await open("&page=trail-guide&pageload=large");
await p.waitForTimeout(500);
check("larger than Clawtrate shows: says so with the limit", (await text(p, ".page-state")) === "Trail guide is larger than Clawtrate shows (5 MB).");
await p.close();

p = await open("&page=trail-guide&pageload=offline");
await p.waitForTimeout(500);
check("connection lost before the Page loaded: says so", (await text(p, ".page-state")) === "Can't reach the gateway. Try again when it's back.");
await p.close();
p = await open("&page=trail-guide&state=readonly");
await p.waitForTimeout(500);
check("read-only: the chat's messages, and the access bar in the composer's place", (await text(p, ".page-chat .shelf-text")) === "Read-only. Messaging needs permission to change things on the gateway." && (await q(p, () => !document.querySelector("#page-chat-input") && document.querySelectorAll("#page-chat-log .msg").length === 4)));
await p.close();

p = await open("&page=trail-guide", { width: 800, height: 760 });
await p.waitForTimeout(500);
check("at 800: the frame takes the width, the chat starts hidden", await q(p, () => document.querySelector(".page-view").classList.contains("chat-hidden") && document.querySelector('[data-pv="chat"]').getAttribute("aria-pressed") === "false"));
await p.click('[data-pv="chat"]');
check("…Chat opens it over the frame's right, focus in its field", await q(p, () => getComputedStyle(document.querySelector(".page-chat")).position === "absolute" && document.activeElement.id === "page-chat-input"));
await p.close();

// The page card in the conversation -----------------------------------------------------------------

p = await open("");
check("F-209 two cards of one Page: the earlier one reads Shown again below", await q(p, () => document.querySelector("#card-p1 .artifact-sub").textContent === "Page · Shown again below" && document.querySelector("#card-p2 .artifact-sub").textContent === "Page"));
await p.click("#card-p1 .artifact-main");
await p.waitForTimeout(450);
check("the card's Open opens the Page view, not the media viewer", await q(p, () => Boolean(document.querySelector(".page-view")) && !document.querySelector(".viewer")));
await p.close();

// Export --------------------------------------------------------------------------------------------

p = await open("&page=trail-guide");
await p.waitForTimeout(500);
await p.keyboard.press("Meta+e");
check("F-210 Export: As shown here, chosen first, and As Marlow made it", await q(p, () => [...document.querySelectorAll(".export-choice strong")].map((x) => x.textContent).join() === "As shown here,As Marlow made it" && document.querySelector('input[value="shown"]').checked));
const exportText = await text(p, ".export-card");
check("F-210 it says what each file is, that scripts run with whatever opens it, and that nothing is uploaded", exportText.includes("its 3 scripts, its link addresses and anything it would load are taken out") && exportText.includes("Opened in a browser, those scripts run with that browser's access, and they can load files from other sites.") && exportText.includes("Only the page's HTML: files kept beside it on the gateway aren't included. The file is saved on this device; nothing is uploaded."));
check("F-210 nothing calls the file safe, private or shared", !/\b(safe|safely|private|secure|shared)\b/i.test(exportText));
let [download] = await Promise.all([p.waitForEvent("download"), p.click('[data-ex="save"]')]);
let saved = await readFile(await download.path(), "utf8");
check("F-210 Save… writes Trail guide.html as shown: no script, no link address", download.suggestedFilename() === "Trail guide.html" && !/<script/i.test(saved) && !/href=/i.test(saved));
check("…announced, and the dialog closes with focus on Export…", (await announced(p)).includes("Exported Trail guide.html") && (await q(p, () => !document.querySelector(".export-dialog") && document.activeElement.dataset.pv === "export")));
await p.click('[data-pv="export"]');
await p.check('input[value="raw"]');
[download] = await Promise.all([p.waitForEvent("download"), p.click('[data-ex="save"]')]);
saved = await readFile(await download.path(), "utf8");
check("F-210 As Marlow made it: the gateway's HTML, scripts included", /<script/.test(saved) && saved.includes("https://trails.example/conditions"));
await p.close();
p = await open("&page=trail-guide&export=open&exportfail=1");
await p.waitForTimeout(500);
await p.click('[data-ex="save"]');
check("the system refuses the file: the dialog stays and says why", (await text(p, ".export-error")) === "Couldn't save Trail guide.html. The system said: there is not enough space on the disk." && (await q(p, () => Boolean(document.querySelector(".export-dialog")))));
await p.close();
p = await open("&page=packing-list&export=open");
await p.waitForTimeout(500);
check("a Page without scripts: one sentence in place of the choice", (await text(p, ".export-one")).startsWith("The page as Clawtrate shows it. It has no scripts, so this is also the page as Marlow made it.") && (await q(p, () => !document.querySelector(".export-choice"))));
await p.close();

// The iPhone ----------------------------------------------------------------------------------------

const phone = { width: 390, height: 844 };
p = await open("&width=phone&panel=open&tab=library", phone);
await p.click('[data-lib-more="today"]');
check("F-371 the iPhone's Library is this conversation's, the person's own picture included", await q(p, () => document.querySelector(".library").dataset.scope === "conversation" && Boolean(document.querySelector('.lib-row[data-item="u1"]')) && !document.querySelector('.lib-row[data-item="i6"]')));
check("F-371 the line says what was searched: this conversation", (await text(p, "#lib-fresh span")) === "In this conversation · checked 5:41 PM");
check("F-371 Today, five at a time with Show more, and no Look in more tasks", await q(p, () => document.querySelector(".lib-group h3").textContent === "Today" && document.querySelectorAll('.lib-group[data-group="today"] .lib-row').length === 9 && !document.querySelector('[data-lib="look"]')));
await q(p, () => document.querySelector('[data-lib-open="p2"]').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
check("F-372 touch and hold a Page row: Open, Share as file…, Unpin; no Copy Link, no Open in Web", await q(p, () => [...document.querySelectorAll(".lib-hold .menu-item")].map((x) => x.textContent).join() === "Open,Share as file…,Unpin"));
await p.click('.lib-hold [data-hold="open"]');
check("F-373 a Page on iPhone: a full-screen sheet that says what is true", (await text(p, ".page-sheet-lead")) === "Pages are shown on the desktop app for now." && (await q(p, () => document.querySelector(".page-sheet").innerText.includes("This version of Clawtrate for iPhone can't draw a page.") && !document.querySelector(".page-sheet iframe"))));
await p.click('[data-ps="message"]');
check("F-373 Message about: the sheet closes, the composer holds the words, caret after them", await q(p, () => !document.querySelector(".page-sheet") && document.activeElement.classList.contains("composer-input") && document.activeElement.value === "About the page “Trail guide”: "));
await p.close();
p = await open("&width=phone&panel=open&tab=library&lib=error", phone);
check("F-371 the iPhone's library couldn't load: its words and Try Again", (await text(p, "#panel-library .work-empty h4")) === "Couldn't load this conversation's library" && (await text(p, '#panel-library [data-lib="retry"]')) === "Try Again");
await p.close();
p = await open("&width=phone&panel=open&tab=library&hold=i2", phone);
check("touch and hold another item: Open and Pin", await q(p, () => [...document.querySelectorAll(".lib-hold .menu-item")].map((x) => x.textContent).join() === "Open,Pin"));
await p.close();
p = await open("&width=phone&page=trail-guide", phone);
await p.waitForTimeout(200);
await p.click('[data-ps="share"]');
check("Share as file… on iPhone: the same choice, then the share sheet", await q(p, () => document.querySelector(".export-dialog [data-ex='save']").textContent === "Share…"));
await p.keyboard.press("Escape");
await p.keyboard.press("Escape");
check("Close returns to the chat", await q(p, () => !document.querySelector(".page-sheet")));
await p.close();

p = await open("&width=phone&device=desktop&page=trail-guide", phone);
await p.waitForTimeout(500);
check("a desktop window 390 wide: the Page full width, Chat as a full-width sheet", await q(p, () => Boolean(document.querySelector(".page-frame")) && document.querySelector(".page-view").classList.contains("chat-hidden")));
await p.click('[data-pv="chat"]');
check("…the chat covers the width", await q(p, () => Math.abs(document.querySelector(".page-chat").getBoundingClientRect().width - innerWidth) < 2));
await p.close();

// Screen reader and keyboard ------------------------------------------------------------------------

p = await open(lib);
check("each group is a list labelled by its word; the freshness line is a status", await q(p, () => document.querySelector('.lib-group[data-group="today"] ul').getAttribute("aria-labelledby") === "lib-h-today" && document.querySelector("#lib-fresh").getAttribute("role") === "status"));
check("a row's name says what, where, when, and Open", await q(p, () => document.querySelector('[data-lib-open="p2"]').getAttribute("aria-label") === "Trail guide, Page, in Saturday's trail plan, 5:37 PM, pinned. Open."));
await p.focus('[data-lib-open="p2"]');
await p.keyboard.press("ArrowDown");
check("Down moves to the next row", await q(p, () => document.activeElement.dataset.libOpen === "i5"));
await p.close();

await b.close();
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR")).length;
console.log(`\n${out.length - failed} ok, ${failed} not ok`);
if (failed) process.exit(1);
