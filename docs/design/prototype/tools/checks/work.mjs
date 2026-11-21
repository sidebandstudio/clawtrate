// Behaviour checks for the Work pane (work.html): files, artifacts and the computer.
// Run from the repository root:  node docs/design/prototype/tools/checks/work.mjs
import { readFile } from "node:fs/promises";
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("work.html") + "?chrome=0&theme=light";
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);
// Part 3 sets this: its pages' timers run on a paused clock that each step moves on by the time it
// names, so a check sees the state that time leads to however slowly the machine runs. The pause
// is set before the context has a page, so it has no deadline to miss.
let paused = false;
const open = async (query = "", viewport = { width: 1440, height: 900 }, options = {}) => {
  const context = await b.newContext({ viewport, acceptDownloads: true, ...options });
  if (paused) {
    await context.clock.install();
    await context.clock.pauseAt(Date.now());
  }
  const p = await context.newPage();
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  p.close = () => context.close();
  await p.goto(base + query);
  await (paused ? p.clock.runFor(120) : p.waitForTimeout(120));
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
  return heads.join() === "Changed,Read,Sent in chat" && document.querySelectorAll('#panel-files [data-open]').length === 9;
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
// M1: the three readers, the two kinds of task folder, and which file a path names.
p = await open(`${files}&file=tools/dashboard.js`);
check("M1 a script over 256 KiB in an ordinary task folder is read through the asset reader: shown, with Download and Copy", await q(p, () =>
  !!document.querySelector(".code-view") && !!document.querySelector('[data-files="download"]') && !!document.querySelector('[data-files="copy"]')));
await p.close();
p = await open(`${files}&file=charts/rack-photo.jpg`);
check("M1 a larger task picture uses the workspace reader when the task's folder is established as the workspace", await q(p, () => !!document.querySelector(".reader-image") && !!document.querySelector('[data-files="download"]')));
await p.close();
p = await open(`${files}&file=charts/rack-photo.jpg&taskroot=worktree`);
check("M1 without that evidence the pane stays with the task's readers and names their limit", await q(p, () =>
  !document.querySelector(".reader-image") && !document.querySelector('[data-files="download"]') && document.querySelector(".reader-why").textContent === "rack-photo.jpg is 3.1 MB. From this task's folder the gateway sends pictures up to 1 MB."));
await p.close();
p = await open(`${files}&file=notes/voice-memo.m4a&repo=1`);
check("M1 a repository-backed task has no audio or video playback, at any size", await q(p, () =>
  !document.querySelector("[data-play-file]") && !document.querySelector('[data-files="download"]') && document.querySelector(".reader-why").textContent.startsWith("This task works in a repository the gateway keeps. The gateway sends only text and pictures from it")));
await p.close();
p = await open(`${files}&file=tools/dashboard.js&repo=1`);
check("M1 from a repository, text over 256 KiB can't be sent, even a script", await q(p, () =>
  !document.querySelector(".code-view") && document.querySelector(".reader-why").textContent.includes("From a repository the gateway keeps, it sends text and pictures up to 256 KB")));
await p.close();
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
check("F-320 a successful retry replaces the error with the listing", await q(p, () => !document.querySelector("#panel-files [role=alert]") && document.querySelectorAll("#panel-files [data-open]").length === 9));
await p.close();

p = await open(`${files}&files=stale`);
check("F-320 a failed refresh keeps the list under one line", await q(p, () => document.querySelector(".files-alert").textContent.startsWith("Couldn't refresh. Showing the list from") && document.querySelectorAll("#panel-files [data-open]").length === 9));
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
check("many files: the filter narrows the list and says how many", await q(p, () => /^\d+ of 44 files$/.test(document.querySelector(".files-filter [role=status]").textContent) && document.activeElement.id === "files-filter"));
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
check("F-307 an item with no content says so, with no Download", await q(p, () => !document.querySelector('#panel-files [data-art="download"]') && document.querySelector(".reader-why").textContent.startsWith("The gateway lists this item, but not its content")));
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-screens`);
await p.waitForTimeout(350);
check("F-307 a format with no preview shows its details and Download", await q(p, () => document.querySelector(".reader-why").textContent === "There's no preview for this kind of file." && document.querySelectorAll('#panel-files [data-art="download"]').length === 2));
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-cover`);
await p.waitForTimeout(350);
check("M8 a picture with no content at the gateway: the quiet tile, no Download, and why", await q(p, () => !document.querySelector('#panel-files [data-art="download"]') && !document.querySelector("#reader-body svg:not(.icon)") && document.querySelector(".reader-why").textContent.startsWith("The gateway lists this picture, but not its content")));
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
check("F-304 when items can't be fetched, the menu says Download 2 of 3", await q(p, () => document.querySelector('.artifact-menu [data-mi="all"]').textContent === "Download 2 of 4"));
got = await downloads(p, () => p.click('.artifact-menu [data-mi="all"]'), 2);
check("F-304 it saves the two that can be fetched and says which was left out", got.length === 2 && (await q(p, () => document.querySelector("#announcer").textContent)).includes("library-card.pkpass, lending-faq.pdf can't be downloaded"));
await p.click("#card-a-cover", { button: "right" });
check("a picture with no content has no Download in its menu", await q(p, () => ![...document.querySelectorAll(".artifact-menu .menu-item")].some((x) => x.textContent === "Download")));
await p.keyboard.press("Escape");
await p.hover("#card-link .artifact-main");
await p.waitForTimeout(650);
check("F-116 a link's preview appears on hover, fetched then", await q(p, () => !!document.querySelector(".link-preview") && document.querySelector(".link-preview").textContent.includes("library.example")));
await p.click("#card-link .artifact-main");
check("F-116 choosing a link card leaves the app for the browser, not the pane", await q(p, () => location.href.includes("work.html") && document.querySelector(".shell").dataset.panel === "closed"));
await p.close();

// M8, M9: the feed, names, addresses elsewhere, and thumbnails.
p = await open(juniper);
check("M9 an item at another address says where it is, and its menu only opens it in the browser", await q(p, () => {
  document.querySelector("#card-a-faq .artifact-more").click();
  const items = [...document.querySelectorAll(".artifact-menu .menu-item")].map((x) => x.textContent);
  return document.querySelector("#card-a-faq .artifact-sub").textContent === "PDF · from help.library.example" && items.join() === "Open,Open in your browser,Show in Files,Download 2 of 4";
}));
await p.keyboard.press("Escape");
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-faq`);
await p.waitForTimeout(350);
check("M9 opened, it is marked as leaving the app, with no Download and no preview", await q(p, () =>
  document.querySelector(".reader-why").textContent.startsWith("This file is at help.library.example, outside the gateway. Opening it leaves the app") &&
  !document.querySelector('#panel-files [data-art="download"]') && !!document.querySelector('#panel-files [data-art="browser"]')));
await p.close();
p = await open(`${juniper}&viewer=a-chart`);
await p.waitForTimeout(50);
check("M8 an item with no content is left out of the viewer's sequence", await q(p, () => document.querySelector(".viewer-title").textContent.includes("1 of 2") && document.querySelectorAll(".viewer-thumb").length === 2));
await p.close();
p = await open(`${juniper}&panel=open&artifact=a-report`);
await p.waitForTimeout(350);
await p.click(".artifact-raw .link-button");
check("M8 Raw is the card's own record: no bytes and no address", await q(p, () => {
  const t = document.querySelector(".reader .raw-panel").textContent;
  return t.includes('"source": "session-transcript"') && !t.includes("preview_") && !/"(data|url)":/.test(t);
}));
await p.close();
p = await open("&thumbs=original");
check("M9 a thumbnail that comes back as the original, over 2 MB, is dropped: No preview", await q(p, () => document.querySelector("#card-a-growth .media-quiet").textContent.includes("No preview")));
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
check("Sent in chat lists the task's items in the Files tab", await q(p, () => document.querySelectorAll('#panel-files [data-open-artifact]').length === 8));
await p.close();

p = await open(`${juniper}&viewer=a-chart&width=phone`, { width: 390, height: 844 });
await p.waitForTimeout(50);
check("phone: the viewer fills the screen", await q(p, () => document.querySelector(".viewer").getBoundingClientRect().width >= 389));
await p.close();

// Part 3: the computer -----------------------------------------------------------------------

paused = true;
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
check("M3 the note and the caption say the browser is the bot's, used by all of its tasks", await q(p, () =>
  document.querySelector(".computer .files-alert").textContent.startsWith("This is Juniper's browser, used by all of Juniper's tasks.") &&
  document.querySelector(".screen-caption").textContent.startsWith("Juniper's browser, used by all of its tasks")));
await p.click('[data-cmp="note-ok"]');
check("Got it removes the note for good", await q(p, () => !document.querySelector('[data-cmp="note-ok"]')));
check("F-144 the banner says the bot waits, with Take control and Show the question", await q(p, () => document.querySelector(".computer-banner strong").textContent === "Juniper is waiting for you" && !!document.querySelector('.computer-banner [data-cmp="take"]')));
await p.click('[data-cmp="watch"]');
check("Watch connects first", await q(p, () => document.querySelector('.screen[data-state="connecting"]').getAttribute("aria-busy") === "true"));
await p.clock.runFor(600);
check("F-140 F-143 then the live picture, labelled Live, with Open and Stop watching", await q(p, () =>
  !!document.querySelector('.screen[data-state="live"] svg') && document.querySelector(".screen-live").textContent === "Live" && !!document.querySelector('[data-cmp="open"]') && !!document.querySelector('[data-cmp="stop"]')));
await p.click("#tab-files");
await p.click("#tab-computer");
check("leaving the Computer tab ends the view", await q(p, () => !document.querySelector(".screen > svg") && !!document.querySelector('[data-cmp="watch"]')));
await p.check('[data-cmp="auto"]');
await p.click("#tab-files");
await p.click("#tab-computer");
await p.clock.runFor(600);
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
await p.clock.runFor(1000);
check("F-145 granted: the question's own answers and Give back control", await q(p, () =>
  [...document.querySelectorAll(".control-bar .button")].map((x) => x.textContent).join() === "I'm done,Skip,Give back control" && document.querySelector(".screen-frame").dataset.control === "true"));
check("the bar says which input reaches the page", await q(p, () => document.querySelector(".control-note").textContent.startsWith("Clicks, scrolling and typed text reach the page; Enter, Tab and other keys don't yet.")));
check("M4 the bar promises only that new browser actions are paused, says earlier work can still act, and names the ways it leaves open", await q(p, () => {
  const t = document.querySelector(".control-note").textContent;
  return t.includes("Juniper's new browser actions are paused, in every one of Juniper's tasks; something it already started can still change this page") && t.includes("Other ways in aren't blocked: the gateway's own browser controls, and other tools such as commands") && !/can't act|can't use its browser/.test(t);
}));
check("R2 the bar never shows You have control by itself: its second line says new actions are paused and earlier work can still change the page", await q(p, () => {
  const bar = document.querySelector(".control-bar");
  return bar.textContent.startsWith("You have control") &&
    bar.querySelector(".control-paused").textContent === "Juniper's new browser actions are paused. Something it already started can still change this page.";
}));
check("taking control is an event line in the conversation", await q(p, () => [...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You took control of Juniper's browser"))));
await p.focus(".screen-frame");
await p.keyboard.type("2208");
check("typing goes to the page as text", await q(p, () => window.CT.work.computer.typed === "2208" && document.querySelector(".screen-frame svg").textContent.includes("2208")));
await p.keyboard.press("Enter");
check("Enter is not sent, and the view says so", await q(p, () => !document.querySelector(".screen-hint").hidden && document.querySelector(".screen-hint").textContent.startsWith("Enter isn't sent to the page")));
await p.focus(".screen-frame");
await p.keyboard.press("Tab");
check("Tab on the controlled picture is not sent: focus moves on", await q(p, () => !document.activeElement.classList.contains("screen-frame") && window.CT.work.computer.typed === "2208"));
await p.focus(".screen-frame");
await p.keyboard.press("Escape");
check("Escape in control never hands back: it moves to Give back control", await q(p, () => document.activeElement.dataset.cmp === "release" && window.CT.work.computer.control === "granted"));
await p.click('.control-bar [data-answer="0"]');
check("M7 an answer first gives control back, and says so; nothing is answered yet", await q(p, () =>
  document.querySelector(".control-bar").textContent === "Giving control back…" && document.querySelector("#q-library").dataset.state === "pending"));
check("M7 until the release is confirmed, the bar neither says Watching nor offers Take control", await q(p, () =>
  !document.querySelector(".screen-view .screen-mode") && !document.querySelector('.screen-view [data-cmp="take"]')));
await p.clock.runFor(500);
check("M7 once the release is confirmed, the answer is sent", await q(p, () => document.querySelector(".control-bar").textContent === "Sending your answer…" && window.CT.work.computer.control === "answering"));
await p.clock.runFor(500);
check("F-145 then the question is answered with the answer chosen, I'm done, and control is back with the bot", await q(p, () =>
  window.CT.work.computer.control === "none" && document.querySelector("#q-library").dataset.state === "answered" &&
  [...document.querySelectorAll("#q-library .answer > span:nth-child(2)")].map((x) => x.textContent).join() === "I'm done" &&
  document.querySelector(".control-bar").textContent === "Answer sent. Juniper can carry on." &&
  [...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You gave control back"))));
await p.close();

p = await open(comp + "&computer=control");
await p.clock.runFor(50);
await p.click('.screen-view [data-cmp="release"]');
await p.clock.runFor(500);
check("F-145 Give back control alone leaves the bot waiting", await q(p, () => document.querySelector(".computer-banner strong").textContent === "Juniper is still waiting for you" && document.querySelector("#q-library").dataset.state === "pending"));
await p.close();

// M7: giving back control, in every ending (work-pane.md, section 18).
// A refused release.
p = await open(comp + "&computer=releasefail");
await p.clock.runFor(50);
await p.click('.screen-view .control-bar [data-answer="0"]');
await p.clock.runFor(500);
check("M7 a refused release: ownership unconfirmed, nothing claimed, input stopped, and no answer sent", await q(p, () => {
  const bar = document.querySelector(".screen-view .control-bar").textContent;
  return window.CT.work.computer.control === "unconfirmed" && bar.startsWith("Giving control back wasn't confirmed. This device may still have control of Juniper's browser.") &&
    bar.includes("Your answer wasn't sent.") && !/You (still )?have control|ended/.test(bar) && document.querySelector(".screen-frame").dataset.control === "false" && document.querySelector("#q-library").dataset.state === "pending";
}));
await p.focus(".screen-view .screen-frame");
await p.keyboard.type("99");
check("M7 while unconfirmed, typing reaches nothing", await q(p, () => window.CT.work.computer.typed === ""));
await p.click('.screen-view [data-cmp="check-release"]');
check("M7 Check renews with the generation: renewed is evidence control is still held", await q(p, () => window.CT.work.computer.control === "granted" && document.querySelector(".screen-view").textContent.includes("You still have control.")));
await p.close();

// No answer to the release, then Check says it ended, with no cause.
p = await open(comp + "&computer=releaseunknown");
await p.clock.runFor(50);
await p.click('.screen-view [data-cmp="release"]');
await p.clock.runFor(500);
check("M7 no answer to the release: unconfirmed, with Try again and Check", await q(p, () =>
  window.CT.work.computer.control === "unconfirmed" && !!document.querySelector('.screen-view [data-cmp="check-release"]') && !!document.querySelector('.screen-view .control-bar [data-cmp="release"]')));
await p.click('.screen-view [data-cmp="check-release"]');
check("M7 a renewal that isn't renewed: Your control ended, with no cause and nothing about the browser being free", await q(p, () => {
  const t = document.querySelector(".screen-view .control-bar").textContent;
  return window.CT.work.computer.control === "ended" && t.startsWith("Your control ended.") && !/expired|revoked|free|stopped hearing/.test(t);
}));
await p.close();

// Leaving after a refused release, and coming back.
p = await open(comp + "&computer=releasefail", { width: 1100, height: 760 });
await p.clock.runFor(50);
await p.click('.screen-view [data-cmp="close-full"]');
await p.click("#tab-files");
await p.clock.runFor(500);
check("M7 leaving after a refused release: the frames go at once and renewals stop", await q(p, () =>
  window.CT.work.computer.view === "idle" && !document.querySelector(".screen-view") && window.CT.work.computer.renewing === false && window.CT.work.computer.control === "unconfirmed"));
await p.click("#tab-computer");
check("M7 coming back: a visible line says control may still be held, with Give it back, and never Watch beside You have control", await q(p, () => {
  const line = document.querySelector(".computer-held");
  return line.textContent.startsWith("This device may still have control of Juniper's browser. Giving it back wasn't confirmed") && !!line.querySelector('[data-cmp="release"]') &&
    !/You have control/.test(document.querySelector("#panel-computer").textContent);
}));
await work(p, "lease-ends");
check("M7 an expired event for this lease ends it, with its reported cause", await q(p, () => document.querySelector(".computer-held").textContent === "Your control ended. It expired."));
await p.close();

// A drop during the release.
p = await open(comp + "&computer=control");
await p.clock.runFor(50);
await p.click('.screen-view .control-bar [data-answer="0"]');
await q(p, () => window.app.setConnection("reconnecting"));
await p.clock.runFor(1100);
check("M7 a drop during the release retires the sequence: no release assumed, no answer sent", await q(p, () =>
  window.CT.work.computer.control === "maybeheld" && document.querySelector("#q-library").dataset.state === "pending" &&
  ![...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You gave control back"))));
check("M7 …and says input has stopped and the gateway ends control when it observes the close", await q(p, () => document.querySelector(".computer-held").textContent === "The connection dropped. Input has stopped. The gateway ends control when it observes this connection close; check its state after reconnecting."));
await q(p, () => window.app.setConnection("connected"));
check("M7 on reconnect it reads the question and the browser again before offering anything", await q(p, () =>
  window.CT.work.computer.control === "checking" && !document.querySelector(".computer-banner") && !document.querySelector('#panel-computer [data-cmp="take"]')));
await p.clock.runFor(600);
check("M7 …then shows what it read, and the queued answer was never sent", await q(p, () =>
  window.CT.work.computer.control === "ended" && document.querySelector("#q-library").dataset.state === "pending" && !!document.querySelector(".computer-banner")));
await p.close();

// A drop while holding.
p = await open(comp + "&computer=control");
await p.clock.runFor(50);
await q(p, () => window.app.setConnection("reconnecting"));
check("M7 a drop while holding: the view ends and the tab says the gateway ends control when it observes the close", await q(p, () =>
  !document.querySelector(".screen-view") && window.CT.work.computer.control === "maybeheld" && !document.querySelector('#panel-computer [data-cmp="take"]') &&
  document.querySelector(".computer-held").textContent.startsWith("The connection dropped. Input has stopped.")));
await p.close();

// The question closes during the release.
p = await open(comp + "&computer=control");
await p.clock.runFor(50);
await p.click('.screen-view .control-bar [data-answer="0"]');
await work(p, "answered-elsewhere");
await p.clock.runFor(1000);
check("M7 the question answered elsewhere during the release: the queued answer is removed and the bar says why", await q(p, () =>
  window.CT.work.computer.control === "none" && document.querySelector(".control-bar").textContent === "Juniper's question was answered on another device, so your answer wasn't sent." &&
  document.querySelector("#q-library").dataset.state === "pending" && !document.querySelector(".computer-banner")));
await p.close();

// The task's run ends during the release.
p = await open(comp + "&computer=control");
await p.clock.runFor(50);
await p.click('.screen-view .control-bar [data-answer="0"]');
await work(p, "run-ends");
await p.clock.runFor(1000);
check("M7 the run ends during the release: the answer is removed, the bar says why, and nothing says the bot is waiting", await q(p, () =>
  window.CT.work.computer.control === "none" && document.querySelector(".control-bar").textContent === "Juniper's run ended, so your answer wasn't sent." &&
  !/still waiting/.test(document.body.textContent)));
await p.close();
p = await open(comp + "&computer=complexquestion");
await p.clock.runFor(50);
check("M7 a question the bar can't answer offers Give back control and answer instead", await q(p, () => !document.querySelector('.control-bar [data-answer]') && !!document.querySelector('.control-bar [data-cmp="answer-in-chat"]')));
await p.click('.control-bar [data-cmp="answer-in-chat"]');
await p.clock.runFor(500);
check("…which gives control back first, then shows the question card", await q(p, () => window.CT.work.computer.control === "none" && !document.querySelector(".screen-view") && document.activeElement.id === "q-library"));
await p.close();

// M6: cancelling and leaving, and answers that arrive late.
p = await open(comp, { width: 1100, height: 760 });
await p.click('[data-cmp="watch"]');
await p.click("#tab-files");
await p.clock.runFor(700);
check("M6 leaving while the view connects: nothing goes live, and the late ticket is disposed of", await q(p, () => window.CT.work.computer.view !== "live" && window.CT.work.computer.disposed.includes("ticket")));
await p.click("#tab-computer");
check("…coming back shows Watch, not the browser", await q(p, () => !!document.querySelector('[data-cmp="watch"]') && !document.querySelector(".screen > svg")));
await p.close();
p = await open(comp + "&computer=watching", { width: 1100, height: 760 });
await p.click('[data-cmp="open"]');
await p.click('.screen-view [data-cmp="take"]');
await p.click('.screen-view [data-cmp="cancel-take"]');
await p.clock.runFor(1100);
check("M6 Cancel while waiting withdraws the take with its generation: no grant, and nothing claims control", await q(p, () =>
  window.CT.work.computer.control !== "granted" && window.CT.work.computer.withdrawals.join() === "g1" && window.CT.work.computer.lateReleased === 0 &&
  !/You have control/.test(document.body.textContent) && ![...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You took control"))));
await p.close();
p = await open(comp + "&computer=watching&takerace=grant", { width: 1100, height: 760 });
await p.click('[data-cmp="open"]');
await p.click('.screen-view [data-cmp="take"]');
await p.click('.screen-view [data-cmp="cancel-take"]');
await p.clock.runFor(1100);
check("M6 a grant that wins the race against the withdrawal is given back at once and never shown", await q(p, () =>
  window.CT.work.computer.control !== "granted" && window.CT.work.computer.lateReleased === 1 && !/You have control/.test(document.body.textContent)));
await p.close();
p = await open(comp + "&computer=watching", { width: 1100, height: 760 });
await p.click('[data-cmp="open"]');
await p.click('.screen-view [data-cmp="take"]');
await p.click('.screen-view [data-cmp="close-full"]');
await p.click("#tab-files");
await p.clock.runFor(1100);
await p.click("#tab-computer");
check("M6 leaving while waiting withdraws the take, and nothing claims control", await q(p, () =>
  window.CT.work.computer.control !== "granted" && window.CT.work.computer.withdrawals.length === 1 && window.CT.work.computer.lateReleased === 0 && !document.querySelector(".screen > svg") && !/You have control/.test(document.querySelector("#panel-computer").textContent)));
await p.close();
p = await open(comp + "&computer=control", { width: 1100, height: 760 });
await p.clock.runFor(50);
await p.click('.screen-view [data-cmp="close-full"]');
check("M6 closing the full view keeps control, with Give back control in the tile", await q(p, () => window.CT.work.computer.control === "granted" && !!document.querySelector('#panel-computer [data-cmp="release"]')));
check("R2 the tile in control says the same second line beside You have control", await q(p, () =>
  document.querySelector("#panel-computer .screen-caption .control-paused")?.textContent === "Juniper's new browser actions are paused. Something it already started can still change this page."));
await p.click("#tab-files");
await p.clock.runFor(500);
check("M6 leaving the tab while in control gives control back first", await q(p, () =>
  window.CT.work.computer.control === "none" && window.CT.work.computer.view === "idle" && [...document.querySelectorAll("#transcript .event-line")].some((e) => e.textContent.startsWith("You gave control back"))));
await p.close();

// Read-only: no view at all, but the control state, files and artifacts.
p = await open(comp + "&state=readonly&computer=control");
await p.clock.runFor(100);
check("read-only: no full view, no picture and no control, whatever the address asks", await q(p, () =>
  !document.querySelector(".screen-view") && !document.querySelector(".screen > svg") && window.CT.work.computer.control === "none" && !/You have control/.test(document.body.textContent)));
await p.close();
p = await open(comp + "&state=readonly&computer=elsewhere");
check("read-only: the control state still shows, from the gateway's events", await q(p, () => document.querySelector("#panel-computer").textContent.includes("Someone on another device has control of Juniper's browser.")));
await p.click("#tab-files");
check("read-only: files and artifacts still show", await q(p, () => document.querySelectorAll("#panel-files [data-open-artifact]").length === 8));
await p.close();

for (const [m, words, name] of [
  ["busy", "Juniper is still acting in this browser. Try again in a moment.", "still acting"],
  ["unsettled", "Something Juniper started in this browser hasn't finished yet, such as a page still loading or a download. Try again in a moment.", "the bot's work hasn't settled"],
  ["conflict", "Someone on another device has control of Juniper's browser.", "someone else has control"],
]) {
  p = await open(comp + `&computer=${m}`);
  await p.clock.runFor(50);
  await p.click('.screen-view [data-cmp="take"]');
  await p.clock.runFor(1000);
  check(`F-142 take refused: ${name}`, (await q(p, () => document.querySelector(".control-bar").textContent)).startsWith(words));
  if (m !== "conflict") {
    check(`R2 take refused (${name}) offers to try again, and claims no control`, await q(p, () =>
      !!document.querySelector('.control-bar [data-cmp="take"]') && !/You have control/.test(document.querySelector(".control-bar").textContent)));
  }
  await p.close();
}
p = await open(comp + "&computer=control");
await p.clock.runFor(50);
await work(p, "lease-ends");
check("M7 an expired event for this lease: Your control ended, with the cause it reports", await q(p, () => document.querySelector(".control-bar").textContent.startsWith("Your control ended. It expired.")));
await p.close();
p = await open(comp + "&computer=watching");
await work(p, "tab-closed");
check("when the tab is closed, the tile says so without saying who closed it", await q(p, () => {
  const t = document.querySelector('.screen[data-state="ended"]').textContent;
  return t.startsWith("This tab was closed.") && !t.includes("Juniper closed");
}));
await p.close();
p = await open(comp + "&computer=watching");
await work(p, "browser-gone");
check("R2 when the browser stops answering (1011), the tile says that, not that the tab closed", await q(p, () => {
  const t = document.querySelector('.screen[data-state="ended"]').textContent;
  return t.startsWith("The view ended. Juniper's browser stopped answering.") && !/closed/.test(t);
}));
await p.close();

// When watching is not available.
p = await open(comp + "&computer=noplugin");
check("without the plugin: a calm empty state that says what is missing and what adds it", await q(p, () =>
  document.querySelector(".computer-empty h4").textContent === "Watching isn't set up on this gateway" &&
  document.querySelector(".computer-empty p").textContent.includes("installs Clawtrate's computer plugin") && !document.querySelector(".screen")));
check("F-275 M5 without the plugin the tab says only what is established about sharing", await q(p, () => document.querySelector(".computer-shared").textContent === "Without it, nothing here gives Juniper a browser of its own. By default, bots that use the browser share one profile, with its sign-ins."));
check("M5 without the plugin the browser's machine is not reported", await q(p, () => [...document.querySelectorAll("#panel-computer .facts div")].some((d) => d.textContent === "BrowserNot reported.")));
check("without the plugin the machine and actions still show", await q(p, () => [...document.querySelectorAll("#panel-computer h3")].map((h) => h.textContent).join() === "Screen,Machine,Recent actions" && !document.querySelector(".computer-banner")));
await p.close();
p = await open(comp + "&computer=unconfigured");
check("the plugin without this bot says so", await q(p, () => document.querySelector(".computer-empty h4").textContent === "Juniper has no browser of its own yet"));
await p.close();
p = await open(comp + "&state=readonly");
check("read-only: no frames, and a way to ask for access", await q(p, () => document.querySelector('.screen[data-state="blocked"]').textContent.includes("Watching needs a connection that can send") && !document.querySelector('[data-cmp="watch"]') && !!document.querySelector('[data-cmp="request"]')));
await p.close();
p = await open(comp + "&computer=closed");
check("F-141 M5 no tabs: only that, with no stopped state and no Wake", await q(p, () => {
  const t = document.querySelector('.screen[data-state="closed"]').textContent;
  return t.includes("Juniper's browser has no tabs open.") && !/isn't open|starts when|stopped/i.test(t) && !/wake/i.test(document.querySelector("#panel-computer").textContent);
}));
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
check("F-147 M5 the approval's target, the execution record and the setting are three separate rows", await q(p, () => {
  const rows = [...document.querySelectorAll("#panel-computer .facts")[0].querySelectorAll(":scope > div")].map((d) => d.textContent);
  return rows[0] === "Command approval targetmedia-boxRequested 5:31 PM · allowed" &&
    rows[1] === "Commands ran onmedia-boxBy the command at 5:36 PM, from its result" &&
    rows[2] === "Set for OttoCommands: media-boxA setting for Otto. A task can run somewhere else." && rows[3] === "BrowserNot reported.";
}));
check("F-148 M5 the node's state, when it was last seen, and the stats' time; never a heartbeat", await q(p, () => {
  const t = document.querySelector("#panel-computer").textContent;
  return t.includes("StateConnected") && t.includes("Last seen40 s ago") && t.includes("Disk780 GB of 2 TB free") && t.includes("As of 5:40 PM") && !/heartbeat/i.test(t);
}));
check("F-153 commands with how each ended", await q(p, () => document.querySelectorAll(".command-row").length === 3 && document.querySelector(".command-row span").textContent === "exit 0 · 2.1s"));
await p.click('.action-row[data-show-step="st-du"]');
check("F-154 an action leads to its step", await q(p, () => document.querySelector("#st-du").open && document.activeElement === document.querySelector("#st-du > summary")));
await p.close();
p = await open("&panel=open&tab=computer&computer=offline");
check("F-148 F-150 a node that isn't connected: its state, when last seen with its reason, and Check again", await q(p, () => {
  const t = document.querySelector("#panel-computer").textContent;
  return t.includes("StateNot connected") && t.includes("Last seen5:12 PM, while going to sleep") && document.querySelector("#panel-computer [role=alert]").textContent.startsWith("media-box isn't connected to the gateway") && !/recover|reset|offline/i.test(t);
}));
await p.click('[data-cmp="check"]');
await p.clock.runFor(800);
check("Check again reads the node again and says when", await q(p, () => document.querySelector("#panel-computer [role=alert]").textContent.includes("Checked 5:42 PM")));
await p.close();
p = await open("&panel=open&tab=computer&computer=nodeunknown");
check("M5 a node whose record couldn't be read is Unknown, with the last value read, never Not connected", await q(p, () => {
  const t = document.querySelector("#panel-computer").textContent;
  return t.includes("StateUnknownConnected when last read, 5:38 PM") && !t.includes("Not connected");
}));
await p.close();
p = await open(comp);
check("M5 a task with no approval request reports no target, and with no execution record makes no claim of where commands ran", await q(p, () => {
  const rows = [...document.querySelectorAll("#panel-computer .facts div")].map((d) => d.textContent);
  return rows.includes("Command approval targetNot reported in this task.") && !rows.some((r) => r.startsWith("Commands ran on"));
}));
await p.close();

p = await open(comp + "&computer=watching&motion=reduce");
check("reduced motion: the watched pointer holds still", await q(p, () => document.getAnimations().filter((a) => a.playState === "running").length === 0));
await p.close();
p = await open("&bot=juniper&task=j2&computer=full&width=phone", { width: 390, height: 844 });
await p.clock.runFor(50);
check("phone: the full view fills the screen", await q(p, () => document.querySelector(".screen-view").getBoundingClientRect().width >= 389));
await p.close();

// A long name shortens before its extension, which stays in view.
p = await open(`${files}&folder=logs`, { width: 1100, height: 760 });
check("a long file name keeps its extension in view", await q(p, () => {
  const row = document.querySelector('[data-open="logs/media-0002.log"] .file-name');
  row.querySelector(".fn-base").textContent = "media-server-transcode-output-for-the-weekend-batch-0002";
  const ext = row.querySelector(".fn-ext").getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return ext.right <= box.right + 1 && ext.width > 10 && row.querySelector(".fn-base").scrollWidth > row.querySelector(".fn-base").clientWidth;
}));
await p.close();

// M10: taking over on a phone.
p = await open("&bot=juniper&task=j2&computer=full&width=phone", { width: 390, height: 844 });
await p.clock.runFor(100);
check("M10 phone, watching: the page opens fitted to the screen's width", await q(p, () => {
  const frame = document.querySelector(".screen-view .screen-frame").getBoundingClientRect();
  return document.querySelector(".screen-view").dataset.layout === "phone" && frame.width <= 390 && frame.width > 300;
}));
check("M10 phone, watching: Take control is the dock's one button", await q(p, () => [...document.querySelectorAll(".control-dock .button")].map((x) => x.textContent).join() === "Take control"));
await p.close();
p = await open("&bot=juniper&task=j2&computer=control&width=phone", { width: 390, height: 844 });
await p.clock.runFor(100);
check("M10 phone, in control: the page opens at its own size, so its 48px fields are 48 points", await q(p, () => document.querySelector(".screen-view .screen-frame").getBoundingClientRect().width === 1280));
check("M10 it opens centred on the last place acted on, and can be panned", await q(p, () => {
  const box = document.querySelector(".screen-zoom");
  const before = box.scrollLeft;
  box.scrollLeft += 120;
  return before > 0 && box.scrollWidth > box.clientWidth && box.scrollLeft === before + 120;
}));
await p.click('[data-cmp="zoom-fit"]');
check("M10 Fit shows the whole page; Zoom out is then disabled", await q(p, () => document.querySelector(".screen-view .screen-frame").getBoundingClientRect().width < 390 && document.querySelector('[data-cmp="zoom-out"]').disabled));
await p.click('[data-cmp="zoom-in"]');
check("M10 Zoom in enlarges the picture on the device, sending nothing", await q(p, () => document.querySelector(".screen-view .screen-frame").getBoundingClientRect().width > 600 && window.CT.work.computer.typed === ""));
check("M10 zoom, keyboard and dock controls have 44-point hit areas or more", await q(p, () =>
  [...document.querySelectorAll(".zoom-controls button, .keyboard-button, .control-dock .button")].every((x) => x.getBoundingClientRect().height >= 44 && x.getBoundingClientRect().width >= 44)));
check("R3 phone, in control: the dock says You have control with its second line together, full width, above its buttons, all on screen", await q(p, () => {
  const dock = document.querySelector(".control-dock");
  const title = dock.querySelector(".control-bar > strong").getBoundingClientRect();
  const line = dock.querySelector(".control-paused");
  const paused = line.getBoundingClientRect();
  const first = dock.querySelector(".button").getBoundingClientRect();
  return dock.querySelector(".control-bar > strong").textContent === "You have control" && title.height > 0 &&
    line.textContent === "Juniper's new browser actions are paused. Something it already started can still change this page." &&
    paused.top >= title.bottom && paused.top - title.bottom < 16 && paused.bottom <= first.top &&
    paused.width > 300 && paused.bottom <= innerHeight;
}));
check("M10 the dock: the first answer full width, then Skip and Give back control", await q(p, () => {
  const buttons = [...document.querySelectorAll(".control-dock .button")];
  return buttons.map((x) => x.textContent).join() === "I'm done,Skip,Give back control" && buttons[0].getBoundingClientRect().width > buttons[1].getBoundingClientRect().width;
}));
check("M10 what reaches the page is folded into one line above the dock", await q(p, () => document.querySelector(".control-help summary").textContent === "What reaches the page" && !document.querySelector(".control-help").open));
await p.click('[data-cmp="keyboard"]');
check("M10 the keyboard button opens a field above the keyboard", await q(p, () => document.activeElement.id === "type-input"));
await p.keyboard.type("4402");
check("M10 each character is sent as text as it is typed", await q(p, () => window.CT.work.computer.typed === "4402" && document.querySelector(".screen-frame svg").textContent.includes("4402")));
await p.keyboard.press("Enter");
check("M10 Return isn't sent, and the view says so", await q(p, () => document.querySelector(".screen-hint").textContent.startsWith("Enter isn't sent to the page. Tap the page's button instead.")));
await p.click('[data-cmp="type-done"]');
check("M10 Done closes the field and clears it", await q(p, () => !document.querySelector("#type-input") && window.CT.work.computer.typedNow === "" && document.activeElement.dataset.cmp === "keyboard"));
await p.close();

await b.close();
console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL") || l.startsWith("PAGEERROR")).length;
console.log(`\n${out.length - failed} ok, ${failed} not ok`);
if (failed) process.exit(1);
