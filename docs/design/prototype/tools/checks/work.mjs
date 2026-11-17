// Behaviour checks for the Work pane (work.html): files, artifacts and the computer.
// Run from the repository root:  node docs/design/prototype/tools/checks/work.mjs
import { readFile } from "node:fs/promises";
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("work.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
const open = async (query = "", viewport = { width: 1440, height: 900 }, options = {}) => {
  const p = await b.newPage({ viewport, acceptDownloads: true, ...options });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  await p.goto(base + query);
  await p.waitForTimeout(120);
  return p;
};
const q = (p, fn, arg) => p.evaluate(fn, arg);
const files = "&panel=open&tab=files";

// Part 1: the pane and its files ---------------------------------------------------------------

let p = await open(files);
check("the pane's one tab bar: Details, Files, Computer, Settings", await q(p, () => [...document.querySelectorAll(".tabs .tab")].map((x) => x.textContent).join() === "Details,Files,Computer,Settings"));
await p.focus("#tab-files");
await p.keyboard.press("End");
check("End reaches Settings, which keeps its place when the task changes", await q(p, () => document.activeElement.id === "tab-settings" && !document.querySelector("#panel-settings").hidden));
await p.click('.task[data-task="o3"]');
check("…the tab stays as it is on another task", await q(p, () => document.querySelector("#tab-settings").getAttribute("aria-selected") === "true"));
await p.click("#tab-files");
await p.click('.task[data-task="o1"]');
await p.close();

// The tab bar's overflow rule, shared with the settings design (bots.md, section 19).
p = await open("&bot=juniper&task=j2&computer=active&panel=open&tab=computer", { width: 1100, height: 760 });
check("English labels fit the 360px drawer with full padding", await q(p, () => !document.querySelector(".tabs").dataset.fit && getComputedStyle(document.querySelector(".tab")).paddingLeft === "14px"));
const relabel = (labels) =>
  q(p, (ls) => {
    const tabs = [...document.querySelectorAll(".tabs .tab")];
    tabs.forEach((tab, i) => (tab.firstChild.textContent = ls[i]));
    window.CT.fitTabs();
  }, labels);
await relabel(["Detalles", "Archivos", "Ordenador", "Ajustes"]);
check("slightly longer labels: side padding narrows to 10px first, no scrolling", await q(p, () => {
  const bar = document.querySelector(".tabs");
  return bar.dataset.fit === "narrow" && getComputedStyle(document.querySelector(".tab")).paddingLeft === "10px" && bar.scrollWidth <= bar.clientWidth;
}));
await relabel(["Einzelheiten", "Dateien", "Arbeitsrechner", "Einstellungen"]);
check("labels that still don't fit: the row scrolls, no tab wraps or shortens", await q(p, () => {
  const bar = document.querySelector(".tabs");
  const tabs = [...bar.querySelectorAll(".tab")];
  return bar.dataset.fit === "scroll" && bar.scrollWidth > bar.clientWidth && tabs.every((t) => t.getBoundingClientRect().height <= 33 && t.scrollWidth <= t.clientWidth + 1);
}));
check("the chosen tab is in view, with a fade at the clipped edge", await q(p, () => {
  const bar = document.querySelector(".tabs").getBoundingClientRect();
  const tab = document.querySelector("#tab-computer").getBoundingClientRect();
  return tab.left >= bar.left - 1 && tab.right <= bar.right + 1 && ["start", "end", "both"].includes(document.querySelector(".tabs").dataset.clip);
}));
check("the Computer dot stays on its word's line", await q(p, () => {
  const tab = document.querySelector("#tab-computer").getBoundingClientRect();
  const dot = document.querySelector("#tab-computer .tab-mark").getBoundingClientRect();
  return dot.top > tab.top && dot.bottom < tab.bottom && dot.left > tab.left && dot.right < tab.right;
}));
await p.focus("#tab-computer");
await p.keyboard.press("End");
check("End scrolls the chosen tab into view", await q(p, () => {
  const bar = document.querySelector(".tabs").getBoundingClientRect();
  const tab = document.querySelector("#tab-settings").getBoundingClientRect();
  return document.activeElement.id === "tab-settings" && tab.right <= bar.right + 1 && tab.left >= bar.left - 1;
}));
await p.close();

p = await open(files);
check("F-152 files tab lists the task's changed and read files", await q(p, () => {
  const heads = [...document.querySelectorAll("#panel-files .files h3")].map((h) => h.textContent);
  return heads.join() === "Changed,Read,Sent in chat" && document.querySelectorAll('#panel-files [data-open]').length === 7;
}));
check("F-321 a file changed by a file tool carries the run marker", await q(p, () =>
  document.querySelector('[data-open="notes/disk-2026-11-16.md"]').textContent.includes("Changed last run") &&
  !document.querySelector('[data-open="charts/usage.png"]').textContent.includes("Changed")));
check("row names say folder, size and time", (await q(p, () => document.querySelector('[data-open="inventory.md"]').getAttribute("aria-label"))) === "inventory.md, 1.1 KB, changed Nov 12");
check("freshness line says when the list was checked", await q(p, () => /^Checked \d/.test(document.querySelector(".files-fresh").textContent)));

// The workspace, Back and focus.
await p.click('[data-folder=""]');
check("F-446 workspace opens with its head, folders first", await q(p, () =>
  document.activeElement.id === "files-title" && document.activeElement.textContent === "Otto's workspace" &&
  [...document.querySelectorAll("#panel-files .file-row")].slice(0, 4).every((r) => r.dataset.folder !== undefined)));
await p.click('[data-folder="notes"]');
check("a folder lists its files with size and time", await q(p, () => document.querySelectorAll("#panel-files [data-open]").length === 4 && document.querySelector('[data-open="notes/receipts.pdf"]').textContent.includes("184 KB")));
await p.click('[data-files="sort"]');
check("F-446 sort menu opens on the checked item", await q(p, () => document.activeElement.getAttribute("aria-checked") === "true" && document.activeElement.dataset.sort === "name"));
await p.keyboard.press("ArrowDown");
await p.keyboard.press("Enter");
check("F-446 sorted by modified time", await q(p, () => document.querySelector('[data-files="sort"]').textContent.startsWith("Modified") && document.querySelector("#panel-files [data-open]").dataset.open === "notes/disk-2026-11-16.md"));
await p.click('[data-files="back"]');
check("Back returns and focuses the row that was opened", await q(p, () => document.activeElement.dataset.folder === "notes"));
await p.click('[data-folder="logs"]');
check("a large folder shows its first page and the total", await q(p, () => document.querySelectorAll("#panel-files [data-open]").length === 250 && document.querySelector('[data-files="more"]').textContent.includes("250 of 1,240")));
await p.click('[data-files="more"]');
check("Show 250 more loads the next page in place", await q(p, () => document.querySelectorAll("#panel-files [data-open]").length === 500 && document.activeElement.dataset.files === "more"));
await p.keyboard.press("Escape");
check("Escape goes Back while docked", await q(p, () => document.activeElement.dataset.folder === "logs"));
await p.keyboard.press("Meta+[");
check("⌘[ goes Back", await q(p, () => !document.querySelector(".files-head") && !!document.querySelector('[data-folder=""]')));
await p.close();

// The reader.
p = await open(files);
await p.click('[data-open="notes/disk-2026-11-16.md"]');
check("F-152 the reader opens in the pane, focus on its name", await q(p, () => document.activeElement.id === "files-title" && document.activeElement.textContent === "disk-2026-11-16.md"));
check("markdown opens on Preview, with Source and Changes", await q(p, () => [...document.querySelectorAll("[data-fileview]")].map((x) => `${x.textContent}:${x.getAttribute("aria-selected")}`).join() === "Preview:true,Source:false,Changes:false"));
await p.focus('[data-fileview="preview"]');
await p.keyboard.press("ArrowRight");
check("the view switch moves with the arrow keys", await q(p, () => document.activeElement.dataset.fileview === "source" && document.querySelectorAll(".code-line").length === 10));
await p.keyboard.press("ArrowRight");
check("F-152 Changes lists each change with its patch", await q(p, () => {
  const changes = document.querySelectorAll(".change");
  return changes.length === 2 && document.querySelector('.diff-line[data-kind="del"] .sign').textContent === "−" && changes[1].textContent.includes("Created in this task");
}));
const [dl] = await Promise.all([p.waitForEvent("download"), p.click('[data-files="download"]')]);
const bytes = await readFile(await dl.path());
const expected = await q(p, () => window.CT.work.files["notes/disk-2026-11-16.md"].content);
check("F-319 Download saves the file under its name with its bytes", dl.suggestedFilename() === "disk-2026-11-16.md" && bytes.equals(Buffer.from(expected, "utf8")));
await p.close();
p = await open(`${files}&file=notes/disk-2026-11-16.md&fileview=changes&checkout=1`);
check("M2 the checkout's comparison is labelled with its base, never as this task's", await q(p, () => {
  const groups = [...document.querySelectorAll(".change-group")].map((h) => h.textContent).join();
  const t = document.querySelector("#reader-body").textContent;
  return groups === "This task's changes,In the checkout" && t.includes("Compared with main") && t.includes("This can include changes made before this task.") && !/since (this|the) task began/i.test(t);
}));
check("a source line links to the step", await q(p, () => document.querySelector(".reader-source").textContent.startsWith("Edited by Otto at 5:36 PM")));
await p.close();

for (const [path, words, name] of [
  ["logs/transcode.log", "The gateway sends text up to 256 KB", "text too large"],
  ["notes/cache-walkthrough.mp4", "recordings and videos from a task's folder up to 1 MB", "video over 1 MB"],
  ["notes/receipts.pdf", "isn't text or media. None of the gateway's file methods sends files like this", "not text or media"],
]) {
  p = await open(`${files}&file=${path}`);
  check(`F-449 a file the gateway won't send (${name}) shows its facts and says why`, await q(p, (w) =>
    !document.querySelector('[data-files="download"]') && document.querySelector(".reader-why").textContent.includes(w) &&
    [...document.querySelectorAll(".reader-facts dt")].map((d) => d.textContent).join() === "Name,Size,Modified,Type,Folder", words));
  await p.close();
}
p = await open(`${files}&file=notes/voice-memo.m4a`);
check("M1 a recording up to 1 MB in the task's folder plays in the pane and can be downloaded", await q(p, () => {
  document.querySelector("[data-play-file]").click();
  return document.querySelector("[data-play-file]").getAttribute("aria-pressed") === "true" && !!document.querySelector('[data-files="download"]') && !document.querySelector('[data-files="copy"]');
}));
await p.close();
p = await open(`${files}&file=charts/usage.png`);
check("an image has Download and no Copy; its source is unknown", await q(p, () =>
  !!document.querySelector('[data-files="download"]') && !document.querySelector('[data-files="copy"]') && document.querySelector(".reader-source").textContent.startsWith("No source in this task")));
await p.close();

// From a step to its file, and back.
p = await open("");
await p.click("#act-2 > summary");
await p.click("#st-write2 > summary");
await p.click('#st-write2 [data-open-file]');
check("F-447 Open file on a write step opens the reader on Changes", await q(p, () =>
  document.querySelector(".shell").dataset.panel === "open" && document.activeElement.id === "files-title" &&
  document.querySelector('[data-fileview="changes"]').getAttribute("aria-selected") === "true"));
await p.click('.change[data-change="st-write1"] [data-show-step]');
check("F-447 Show in chat opens and focuses the step; the docked pane stays", await q(p, () =>
  document.querySelector("#st-write1").open && document.querySelector("#act-1").open && document.activeElement === document.querySelector("#st-write1 > summary") &&
  document.querySelector(".shell").dataset.panel === "open"));
check("the step is in view under the protected band", await q(p, () => {
  const t = document.querySelector("#transcript").getBoundingClientRect();
  const s = document.querySelector("#st-write1").getBoundingClientRect();
  return s.top >= t.top + 90 && s.top < t.bottom - 40;
}));
await p.close();

p = await open(`${files}&file=inventory.md`, { width: 1100, height: 760 });
await p.click(".reader-source [data-show-step]");
check("Show in chat from a drawer closes the drawer and shows the step", await q(p, () => document.querySelector(".shell").dataset.panel === "closed" && document.querySelector("#st-read-inv").open));
check("the step offers Back to the file", await q(p, () => !!document.querySelector('#st-read-inv [data-back-to-file="inventory.md"]')));
await p.keyboard.press("Meta+[");
check("⌘[ in the conversation goes back to the file", await q(p, () => document.querySelector(".shell").dataset.panel === "open" && document.querySelector("#files-title").textContent === "inventory.md"));
await p.close();

// The pane remembers each task.
p = await open(`${files}&file=AGENTS.md`);
await p.click('.task[data-task="o3"]');
check("another task starts Files at its top", await q(p, () => !document.querySelector(".files-head") && document.querySelector("#panel-files").textContent.includes("No files yet")));
await p.click('.task[data-task="o1"]');
check("coming back restores the file that was open", await q(p, () => document.querySelector("#files-title")?.textContent === "AGENTS.md"));
await p.close();

// While a bot writes, and keeping the list current.
p = await open(`${files}&files=writing&file=notes/disk-2026-11-16.md&fileview=source`);
check("F-448 a file being written shows the working mark and a line", await q(p, () => document.querySelector(".reader-banner").textContent.includes("Otto is writing this file") && !!document.querySelector(".reader-banner .glyph[data-state='working']")));
await q(p, () => window.CT.work.finishWrite());
await p.waitForTimeout(100);
check("F-448 when the write lands, the open file reloads in place", await q(p, () =>
  document.querySelector(".reader-banner").textContent === "Updated just now" && document.querySelectorAll(".code-line").length === 11 &&
  document.querySelector("#files-title").textContent === "disk-2026-11-16.md"));
await p.waitForTimeout(150);
check("the update is announced", (await q(p, () => document.querySelector("#announcer")?.textContent)) === "disk-2026-11-16.md updated");
check("the reloaded file has the new line and a third change", await q(p, () => {
  document.querySelector('[data-fileview="changes"]').click();
  return document.querySelectorAll(".change").length === 3;
}));
await p.close();

p = await open(`${files}&files=writing`);
check("F-321 a row being written reads Writing…", await q(p, () => document.querySelector('[data-open="notes/disk-2026-11-16.md"]').getAttribute("aria-label") === "disk-2026-11-16.md, Otto is writing it"));
await p.close();

p = await open(`${files}&files=commands`);
check("F-448 the list says commands ran since it was checked", await q(p, () => document.querySelector(".files-fresh-note").textContent.startsWith("Otto ran commands since then")));
await p.click('[data-files="refresh"]');
check("refreshing says Checking…", await q(p, () => document.querySelector(".files-fresh").textContent.startsWith("Checking")));
await p.waitForTimeout(800);
check("after refreshing the note goes and the time updates", await q(p, () => !document.querySelector(".files-fresh-note") && document.querySelector(".files-fresh").textContent.startsWith("Checked 5:41 PM")));
await p.close();

p = await open(`${files}&files=error`);
check("F-320 a failed listing shows the error and Try again", await q(p, () => document.querySelector("#panel-files [role=alert]").textContent.includes("Couldn't load this task's files")));
await p.click('[data-files="retry"]');
await p.waitForTimeout(800);
check("F-320 a successful retry replaces the error with the listing", await q(p, () => !document.querySelector("#panel-files [role=alert]") && document.querySelectorAll("#panel-files [data-open]").length === 7));
await p.close();

p = await open(`${files}&files=stale`);
check("F-320 a failed refresh keeps the list under one line", await q(p, () => document.querySelector(".files-alert").textContent.startsWith("Couldn't refresh. Showing the list from") && document.querySelectorAll("#panel-files [data-open]").length === 7));
await p.close();

p = await open(`${files}&files=loading&motion=reduce`);
check("loading is skeleton rows with aria-busy, still under reduced motion", await q(p, () =>
  document.querySelector('#panel-files [aria-busy="true"]').querySelectorAll(".skeleton-row").length === 3 &&
  document.getAnimations().filter((a) => a.playState === "running").length === 0));
await p.close();

p = await open(`${files}&files=empty`);
check("no files yet: the empty state, then the workspace", await q(p, () => document.querySelector("#panel-files h4").textContent === "No files yet" && !!document.querySelector('[data-folder=""]')));
await p.close();

p = await open(`${files}&files=many`);
await p.fill("#files-filter", "media-2026-10-0");
check("many files: the filter narrows the list and says how many", await q(p, () => /^\d+ of 42 files$/.test(document.querySelector(".files-filter [role=status]").textContent) && document.activeElement.id === "files-filter"));
await p.keyboard.press("Escape");
check("Escape clears the filter", await q(p, () => document.querySelector("#files-filter").value === "" && !document.querySelector(".files-filter [role=status]")));
await p.close();

p = await open(`${files}&state=readonly`);
await p.click('[data-open="inventory.md"]');
check("files work on a read-only connection", await q(p, () => document.querySelector("#files-title").textContent === "inventory.md" && !!document.querySelector('[data-files="download"]')));
await p.close();

p = await open(`${files}&banner=offline`);
check("while the connection is lost the list says when it was last checked, with no Refresh", await q(p, () => document.querySelector(".files-fresh").textContent.startsWith("Last checked") && !document.querySelector('[data-files="refresh"]')));
await p.close();

p = await open(`${files}&width=phone`, { width: 390, height: 844 });
check("phone: Files is a full-width sheet", await q(p, () => {
  const pane = document.querySelector("#work-panel").getBoundingClientRect();
  return pane.width >= 389 && document.querySelector("#work-panel").getAttribute("aria-modal") === "true";
}));
check("phone: rows are touch height", await q(p, () => document.querySelector('[data-open="inventory.md"]').getBoundingClientRect().height >= 56));
await p.click('[data-open="notes/disk-2026-11-16.md"]');
check("phone: the reader opens in the sheet", await q(p, () => document.querySelector("#files-title").textContent === "disk-2026-11-16.md"));
await p.close();

// Part 2: artifacts and media -------------------------------------------------------------------

const juniper = "&bot=juniper&task=j2";
const downloads = async (p, action, count) => {
  const got = [];
  p.on("download", (d) => got.push(d));
  await action();
  for (let i = 0; i < 40 && got.length < count; i++) await p.waitForTimeout(50);
  await p.waitForTimeout(150);
  return got;
};

p = await open("");
check("F-115 a file card shows its name, type and size", (await q(p, () => document.querySelector("#card-a-report .artifact-main").getAttribute("aria-label"))) === "disk-report.md, Markdown, 37 KB. Open in the Work pane.");
await p.click("#card-a-report .artifact-main");
check("F-115 choosing it opens the item in the pane, loading first", await q(p, () => document.querySelector("#files-title").textContent === "disk-report.md" && !!document.querySelector('#reader-body [aria-busy="true"]')));
await p.waitForTimeout(350);
check("F-115 then its preview, with the source line", await q(p, () => !!document.querySelector("#reader-body .reader-preview h2") && document.querySelector(".reader-source").textContent.startsWith("Sent by Otto at 5:37 PM")));
await p.click(".artifact-raw .link-button");
check("Raw shows the artifact's record, never its bytes", await q(p, () => {
  const panel = document.querySelector(".reader .raw-panel");
  return !panel.hidden && panel.textContent.includes('"mode": "bytes"') && !panel.textContent.includes("Transcode cache: about");
}));
await p.click(".reader-source [data-show-card]");
check("F-447 Show in chat on an attachment fills its card and focuses it", await q(p, () => document.querySelector("#card-a-report").dataset.flash === "true" && document.activeElement === document.querySelector("#card-a-report .artifact-main")));
await p.close();

p = await open("");
await p.hover("#card-a-report");
await p.click("#card-a-report .artifact-more");
check("the card's menu opens on its first item", await q(p, () => document.activeElement.dataset.mi === "open" && [...document.querySelectorAll(".artifact-menu .menu-item")].map((x) => x.textContent).join() === "Open,Download,Copy text,Show in Files,Download all 3"));
let got = await downloads(p, () => p.click('.artifact-menu [data-mi="download"]'), 1);
const reportBytes = await readFile(await got[0].path());
check("F-118 Download saves the item under its name with its bytes", got[0].suggestedFilename() === "disk-report.md" && reportBytes.equals(Buffer.from(await q(p, () => window.CT.work.artifacts["a-report"].content), "utf8")));
check("focus returns to the More button", await q(p, () => document.activeElement.classList.contains("artifact-more")));
await p.click("#card-a-report .artifact-more");
got = await downloads(p, () => p.click('.artifact-menu [data-mi="all"]'), 3);
check("F-304 Download all saves every item in the message", got.map((d) => d.suggestedFilename()).sort().join() === "cache-growth.png,disk-report.md,usage.png");
await p.focus("#card-a-usage");
await p.keyboard.press("Shift+F10");
check("Shift+F10 on a picture opens its menu with Copy image and Save image…", await q(p, () => [...document.querySelectorAll(".artifact-menu .menu-item")].map((x) => x.textContent).includes("Save image…")));
got = await downloads(p, () => p.click('.artifact-menu [data-mi="save"]'), 1);
check("F-306 Save image… saves the picture under its name", got[0]?.suggestedFilename() === "usage.png");
await p.keyboard.press("Escape");
await p.click("#card-a-report .artifact-more");
await p.click('.artifact-menu [data-mi="files"]');
check("Show in Files opens the pane at the item in Sent in chat", await q(p, () => document.activeElement.dataset.key === "a:a-report" && [...document.querySelectorAll("#panel-files h3")].some((h) => h.textContent === "Sent in chat")));
await p.close();

const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
p = await ctx.newPage();
await p.goto(base);
await p.click("#card-a-usage", { button: "right" });
await p.click('.artifact-menu [data-mi="copy-image"]');
await p.waitForTimeout(400);
check("F-305 Copy image puts the picture on the clipboard", await q(p, async () => {
  const items = await navigator.clipboard.read();
  return items.some((i) => i.types.includes("image/png")) && document.querySelector("#announcer").textContent === "Copied the image";
}));
await ctx.close();

// The viewer.
p = await open("");
await p.click("#card-a-usage");
check("F-117 a picture opens the viewer with focus on Close", await q(p, () => document.querySelector(".viewer").getAttribute("aria-modal") === "true" && document.activeElement.dataset.v === "close" && document.querySelector(".viewer-title").textContent.includes("1 of 2")));
await p.keyboard.press("ArrowRight");
check("F-117 arrow keys move between items", await q(p, () => document.querySelector(".viewer-title strong").textContent === "cache-growth.png"));
check("the viewer is dark in the light theme", await q(p, () => getComputedStyle(document.querySelector(".viewer")).backgroundColor === "rgb(16, 17, 18)"));
got = await downloads(p, () => p.click('.viewer [data-v="download"]'), 1);
check("F-117 the viewer's Download saves the item", got[0]?.suggestedFilename() === "cache-growth.png");
await p.keyboard.press("Escape");
check("F-117 Escape closes the viewer and returns focus to the picture", await q(p, () => !document.querySelector(".viewer") && document.activeElement.id === "card-a-usage" && !document.querySelector(".shell").inert));
await p.close();

p = await open(`${juniper}&viewer=a-walk`);
await p.waitForTimeout(50);
await p.click('.viewer [data-v="speed"]');
check("F-117 video speed is a menu of 0.5× to 2×", await q(p, () => [...document.querySelectorAll(".speed-menu .menu-item")].map((x) => x.textContent).join() === "0.5×,1×,1.5×,2×" && document.activeElement.dataset.speed === "1×"));
await p.click('[data-speed="2×"]');
check("choosing 2× sets the speed", await q(p, () => document.querySelector('.viewer [data-v="speed"]').textContent === "2×"));
await p.close();

// What cannot be fetched, and failures.
p = await open(`${juniper}&panel=open&artifact=a-card`);
await p.waitForTimeout(350);
check("F-307 an item with no content says so, with no Download", await q(p, () => !document.querySelector('#panel-files [data-art="download"]') && document.querySelector(".reader-why").textContent.startsWith("The gateway has this item's name and type, but not its content")));
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-screens`);
await p.waitForTimeout(350);
check("F-307 a format with no preview shows its details and Download", await q(p, () => document.querySelector(".reader-why").textContent === "There's no preview for this kind of file." && document.querySelectorAll('#panel-files [data-art="download"]').length === 2));
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-cover`);
await p.waitForTimeout(350);
check("a picture kept as a preview only can't be downloaded", await q(p, () => !document.querySelector('#panel-files [data-art="download"]') && document.querySelector(".reader-why").textContent.includes("kept a preview of this picture only")));
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-terms&artifactload=failed`);
await p.waitForTimeout(350);
check("F-307 a failed load shows the error and Try again", await q(p, () => document.querySelector("#reader-body [role=alert]").textContent.startsWith("Couldn't open lending-terms.pdf")));
await p.click('[data-art="retry"]');
await p.waitForTimeout(350);
check("F-307 a successful retry shows the preview", await q(p, () => document.querySelectorAll(".pdf-page").length === 3 && !document.querySelector("#reader-body [role=alert]")));
await p.close();

p = await open(juniper);
await p.click("#card-a-terms .artifact-more");
check("F-304 when one item can't be fetched, the menu says Download 2 of 3", await q(p, () => document.querySelector('.artifact-menu [data-mi="all"]').textContent === "Download 2 of 3"));
got = await downloads(p, () => p.click('.artifact-menu [data-mi="all"]'), 2);
check("F-304 it saves the two that can be fetched and says which was left out", got.length === 2 && (await q(p, () => document.querySelector("#announcer").textContent)).includes("library-card.pkpass can't be downloaded"));
await p.click("#card-a-cover", { button: "right" });
check("a preview-only picture's menu has no Download", await q(p, () => ![...document.querySelectorAll(".artifact-menu .menu-item")].some((x) => x.textContent === "Download")));
await p.keyboard.press("Escape");
await p.hover("#card-link .artifact-main");
await p.waitForTimeout(650);
check("F-116 a link's preview appears on hover, fetched then", await q(p, () => !!document.querySelector(".link-preview") && document.querySelector(".link-preview").textContent.includes("library.example")));
await p.click("#card-link .artifact-main");
check("F-116 choosing a link card leaves the app for the browser, not the pane", await q(p, () => location.href.includes("work.html") && document.querySelector(".shell").dataset.panel === "closed"));
await p.close();

p = await open("&thumbs=failed");
check("a failed thumbnail leaves the quiet tile with No preview", await q(p, () => document.querySelector("#card-a-growth .media-quiet").textContent.includes("No preview")));
await p.click("#card-a-growth");
check("it still opens the viewer", await q(p, () => document.querySelector(".viewer-title strong").textContent === "cache-growth.png"));
await p.close();
p = await open("");
check("before the thumbnail arrives the tile is busy", await q(p, () => document.querySelector("#card-a-growth").getAttribute("aria-busy") === "true"));
await p.waitForTimeout(700);
check("then it shows the thumbnail", await q(p, () => !document.querySelector("#card-a-growth .media-quiet") && !!document.querySelector("#card-a-growth svg")));
await p.close();

p = await open(`${juniper}${files}`);
check("Sent in chat lists the task's items in the Files tab", await q(p, () => document.querySelectorAll('#panel-files [data-open-artifact]').length === 7));
await p.close();

p = await open(`${juniper}&viewer=a-chart&width=phone`, { width: 390, height: 844 });
await p.waitForTimeout(50);
check("phone: the viewer fills the screen", await q(p, () => document.querySelector(".viewer").getBoundingClientRect().width >= 389));
await p.close();

// Part 3: the computer -----------------------------------------------------------------------

const comp = "&bot=juniper&task=j2&panel=open&tab=computer";
const work = (p, what) => p.evaluate((w) => window.CT.work.bar(w), what);

p = await open("&bot=juniper&task=j2&computer=active");
check("F-139 the computer button shows once the task used the browser, marked while in use", await q(p, () => {
  const button = document.querySelector("#computer-button");
  return !button.hidden && button.dataset.active === "true" && button.getAttribute("aria-label") === "Juniper's computer, in use. Show the computer" && !!document.querySelector("#tab-computer .tab-mark");
}));
await p.click("#computer-button");
check("the computer button opens the pane on Computer", await q(p, () => document.querySelector(".shell").dataset.panel === "open" && document.querySelector("#tab-computer").getAttribute("aria-selected") === "true" && document.activeElement.id === "tab-computer"));
await p.close();
p = await open("");
check("a task that never used the browser has no computer button", await q(p, () => document.querySelector("#computer-button").hidden));
await p.close();

p = await open(comp + "&firstwatch=1");
check("F-140 nothing is drawn before Watch", await q(p, () => document.querySelector('.screen[data-state="idle"]') && !document.querySelector(".screen > svg") && !!document.querySelector('.screen [data-cmp="watch"]')));
check("the first watch of a bot carries the one-time note", await q(p, () => document.querySelector(".computer .files-alert").textContent.includes("may be signed in to sites")));
await p.click('[data-cmp="note-ok"]');
check("Got it removes the note for good", await q(p, () => !document.querySelector('[data-cmp="note-ok"]')));
check("F-144 the banner says the bot waits, with Take control and Show the question", await q(p, () => document.querySelector(".computer-banner strong").textContent === "Juniper is waiting for you" && !!document.querySelector('.computer-banner [data-cmp="take"]')));
await p.click('[data-cmp="watch"]');
check("Watch connects first", await q(p, () => document.querySelector('.screen[data-state="connecting"]').getAttribute("aria-busy") === "true"));
await p.waitForTimeout(600);
check("F-140 F-143 then the live picture, labelled Live, with Open and Stop watching", await q(p, () =>
  !!document.querySelector('.screen[data-state="live"] svg') && document.querySelector(".screen-live").textContent === "Live" && !!document.querySelector('[data-cmp="open"]') && !!document.querySelector('[data-cmp="stop"]')));
await p.click("#tab-files");
await p.click("#tab-computer");
check("leaving the Computer tab ends the view", await q(p, () => !document.querySelector(".screen > svg") && !!document.querySelector('[data-cmp="watch"]')));
await p.check('[data-cmp="auto"]');
await p.click("#tab-files");
await p.click("#tab-computer");
await p.waitForTimeout(600);
check("with Show live on, opening Computer watches at once", await q(p, () => !!document.querySelector('.screen[data-state="live"]')));
await p.click('[data-cmp="stop"]');
check("Stop watching clears the picture", await q(p, () => !document.querySelector(".screen > svg") && document.activeElement.dataset.cmp === "watch"));
await p.close();

p = await open(comp + "&computer=watching");
await q(p, () => window.app.setConnection("reconnecting"));
check("a dropped connection ends the view and says so", await q(p, () => document.querySelector('.screen[data-state="ended"]').textContent.includes("when the connection dropped")));
await p.close();

p = await open(comp + "&computer=watching");
await p.click('[data-cmp="open"]');
check("F-142 Open fills the window in Watching mode", await q(p, () => {
  const v = document.querySelector(".screen-view");
  return v.getAttribute("aria-modal") === "true" && v.querySelector(".screen-mode").textContent === "Watching" && document.activeElement.dataset.cmp === "take" && document.querySelector(".shell").inert;
}));
await p.keyboard.press("Escape");
check("F-142 Escape closes the full view, back to Open; watching goes on", await q(p, () => !document.querySelector(".screen-view") && document.activeElement.dataset.cmp === "open" && !!document.querySelector('.screen[data-state="live"]')));
await p.click('[data-cmp="open"]');
await p.click('.screen-view [data-cmp="take"]');
check("F-142 Take control waits for the bot and says so", await q(p, () => document.querySelector(".control-bar").textContent.startsWith("Waiting for Juniper to finish") && !!document.querySelector('[data-cmp="cancel-take"]')));
await p.waitForTimeout(1000);
check("F-145 granted: the question's own answers and Give back control", await q(p, () =>
  [...document.querySelectorAll(".control-bar .button")].map((x) => x.textContent).join() === "I'm done,Skip,Give back control" && document.querySelector(".screen-frame").dataset.control === "true"));
check("the bar says which input reaches the page", await q(p, () => document.querySelector(".control-note").textContent.startsWith("Clicks, scrolling and typed text reach the page. Enter, Tab and other keys don't yet.")));
check("taking control is an event line in the conversation", await q(p, () => [...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You took control of Juniper's browser"))));
await p.focus(".screen-frame");
await p.keyboard.type("2208");
check("typing goes to the page as text", await q(p, () => window.CT.work.computer.typed === "2208" && document.querySelector(".screen-frame svg").textContent.includes("2208")));
await p.keyboard.press("Enter");
check("Enter is not sent, and the view says so", await q(p, () => !document.querySelector(".screen-hint").hidden && document.querySelector(".screen-hint").textContent.startsWith("Enter isn't sent to the page")));
await p.keyboard.press("Escape");
check("Escape in control never hands back: it moves to Give back control", await q(p, () => document.activeElement.dataset.cmp === "release" && window.CT.work.computer.control === "granted"));
await p.click('.control-bar [data-answer="0"]');
check("F-145 an answer answers the question and gives control back", await q(p, () =>
  window.CT.work.computer.control === "none" && document.querySelector("#q-library").dataset.state !== "pending" && [...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You gave control back"))));
await p.close();

p = await open(comp + "&computer=control");
await p.waitForTimeout(50);
await p.click('.screen-view [data-cmp="release"]');
check("F-145 Give back control alone leaves the bot waiting", await q(p, () => document.querySelector(".computer-banner strong").textContent === "Juniper is still waiting for you" && document.querySelector("#q-library").dataset.state === "pending"));
await p.close();

for (const [m, words, name] of [
  ["busy", "Juniper is still acting in this browser. Try again in a moment.", "still acting"],
  ["conflict", "Someone on another device has control of Juniper's browser.", "someone else has control"],
]) {
  p = await open(comp + `&computer=${m}`);
  await p.waitForTimeout(50);
  await p.click('.screen-view [data-cmp="take"]');
  await p.waitForTimeout(1000);
  check(`F-142 take refused: ${name}`, (await q(p, () => document.querySelector(".control-bar").textContent)).startsWith(words));
  await p.close();
}
p = await open(comp + "&computer=control");
await p.waitForTimeout(50);
await work(p, "lease-ends");
check("when the gateway ends the lease, control ends and says why", await q(p, () => document.querySelector(".control-bar").textContent.startsWith("Your control ended. The gateway stopped hearing from this device.")));
await p.close();
p = await open(comp + "&computer=watching");
await work(p, "tab-closed");
check("when the bot closes the tab, the tile says so", await q(p, () => document.querySelector('.screen[data-state="ended"]').textContent.startsWith("Juniper closed this tab.")));
await p.close();

// When watching is not available.
p = await open(comp + "&computer=noplugin");
check("without the plugin: a calm empty state that says what is missing and what adds it", await q(p, () =>
  document.querySelector(".computer-empty h4").textContent === "Watching isn't set up on this gateway" &&
  document.querySelector(".computer-empty p").textContent.includes("installs Clawtrate's computer plugin") && !document.querySelector(".screen")));
check("F-275 without the plugin the tab says every bot shares one browser", await q(p, () => document.querySelector(".computer-shared").textContent.startsWith("Without it, every bot on this gateway shares one browser")));
check("without the plugin the machine and actions still show", await q(p, () => [...document.querySelectorAll("#panel-computer h3")].map((h) => h.textContent).join() === "Screen,Machine,Recent actions" && !document.querySelector(".computer-banner")));
await p.close();
p = await open(comp + "&computer=unconfigured");
check("the plugin without this bot says so", await q(p, () => document.querySelector(".computer-empty h4").textContent === "Juniper has no browser of its own yet"));
await p.close();
p = await open(comp + "&state=readonly");
check("read-only: no frames, and a way to ask for access", await q(p, () => document.querySelector('.screen[data-state="blocked"]').textContent.includes("Watching needs a connection that can send") && !document.querySelector('[data-cmp="watch"]') && !!document.querySelector('[data-cmp="request"]')));
await p.close();
p = await open(comp + "&computer=closed");
check("F-141 a browser with no tabs: it starts when the bot uses it, and no Wake", await q(p, () => document.querySelector('.screen[data-state="closed"]').textContent.includes("isn't open. It starts when Juniper next uses it.") && !/wake/i.test(document.querySelector("#panel-computer").textContent)));
await p.close();
p = await open(comp + "&computer=stuck");
check("a browser that stays busy offers Stop in this task", await q(p, () => document.querySelector(".computer .files-alert").textContent.includes("A call that never finished") && !!document.querySelector('[data-cmp="stop-task"]')));
await p.click('[data-cmp="stop-task"]');
check("F-149 stopping asks first and says what keeps going", await q(p, () => document.querySelector(".stop-confirm").textContent.includes("Juniper's other tasks and other bots keep going") && document.activeElement.dataset.cmp === "cancel-stop"));
await p.click('[data-cmp="confirm-stop"]');
check("F-149 then it stops this task's runs", await q(p, () => document.querySelector(".computer [role=status]").textContent.startsWith("Stopped Juniper's runs in this task")));
await p.close();

// The machine, actions and commands.
p = await open("&panel=open&tab=computer");
check("F-147 the tab names where commands and the browser run", await q(p, () => {
  const rows = [...document.querySelectorAll("#panel-computer .facts")[0].querySelectorAll("div")].map((d) => d.textContent);
  return rows[0] === "Commands run onmedia-box" && rows[1] === "Browser runs onThe gateway's machine, shared with every bot";
}));
check("F-148 the node's state and last heartbeat", await q(p, () => {
  const t = document.querySelector("#panel-computer").textContent;
  return t.includes("StateConnected") && t.includes("Last heartbeat40 s ago") && t.includes("Disk780 GB of 2 TB free");
}));
check("F-153 commands with how each ended", await q(p, () => document.querySelectorAll(".command-row").length === 3 && document.querySelector(".command-row span").textContent === "exit 0 · 2.1s"));
await p.click('.action-row[data-show-step="st-du"]');
check("F-154 an action leads to its step", await q(p, () => document.querySelector("#st-du").open && document.activeElement === document.querySelector("#st-du > summary")));
await p.close();
p = await open("&panel=open&tab=computer&computer=offline");
check("F-148 F-150 an offline node: its state, last heartbeat with reason, and Check again", await q(p, () => {
  const t = document.querySelector("#panel-computer").textContent;
  return t.includes("StateOffline") && t.includes("5:12 PM, while going to sleep") && document.querySelector("#panel-computer [role=alert]").textContent.startsWith("Can't reach media-box") && !/recover|reset/i.test(t);
}));
await p.close();

p = await open(comp + "&computer=watching&motion=reduce");
check("reduced motion: the watched pointer holds still", await q(p, () => document.getAnimations().filter((a) => a.playState === "running").length === 0));
await p.close();
p = await open("&bot=juniper&task=j2&computer=full&width=phone", { width: 390, height: 844 });
await p.waitForTimeout(50);
check("phone: the full view fills the screen", await q(p, () => document.querySelector(".screen-view").getBoundingClientRect().width >= 389));
await p.close();

await b.close();
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR")).length;
console.log(`\n${out.length - failed} ok, ${failed} not ok`);
if (failed) process.exit(1);
