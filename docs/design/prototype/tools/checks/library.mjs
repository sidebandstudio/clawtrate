// Behaviour checks for the Library and Pages (library.html), docs/design/library.md.
// Run from the repository root:  node docs/design/prototype/tools/checks/library.mjs
// Lines tagged R1 to R8 hold the eight corrections of the first review round.
import { readFile } from "node:fs/promises";
import { chromium, pageUrl } from "./browser.mjs";

const base = pageUrl("library.html") + "?chrome=0&theme=light&bot=marlow&task=m2";
const lib = "&panel=open&tab=library";
const phoneSize = { width: 390, height: 844 };
const b = await chromium.launch();
const out = [];
const check = (name, ok, extra = "") => out.push(`${ok ? "ok  " : "FAIL"} ${name}${extra ? ` ${extra}` : ""}`);

// Every request, popup and frame navigation after the page's own files have loaded.
let watch = null;
const open = async (query = "", viewport = { width: 1440, height: 900 }) => {
  const p = await b.newPage({ viewport, acceptDownloads: true });
  p.on("pageerror", (e) => out.push("PAGEERROR " + e));
  await p.goto(base + query);
  await p.waitForTimeout(150);
  return p;
};
function observe(p) {
  const seen = { requests: [], popups: 0, navigations: [], dialogs: 0 };
  p.on("request", (r) => {
    const fromPage = r.frame() !== p.mainFrame();
    if (fromPage || !/^(file|data|blob):/.test(r.url())) seen.requests.push(r.url());
  });
  p.on("popup", () => (seen.popups += 1));
  p.on("dialog", (d) => ((seen.dialogs += 1), d.dismiss()));
  p.on("framenavigated", (f) => f !== p.mainFrame() && f.url() !== "about:srcdoc" && seen.navigations.push(f.url()));
  return seen;
}
const q = (p, fn, arg) => p.evaluate(fn, arg);
const text = (p, sel) => q(p, (s) => document.querySelector(s)?.innerText ?? null, sel);
const announced = async (p) => (await p.waitForTimeout(80), q(p, () => document.querySelector("#announcer")?.textContent ?? ""));
const subOf = (p, id) => q(p, (i) => document.querySelector(`.lib-row[data-item="${i}"] .file-sub`)?.textContent, id);
const counters = (p) => q(p, () => ({ ...window.CT.library.counters }));
const pageFrame = (p) => p.frames().find((f) => f.url() === "about:srcdoc");
const focused = (p) => q(p, () => document.activeElement?.dataset?.libOpen || document.activeElement?.dataset?.pv || document.activeElement?.id || document.activeElement?.textContent?.trim() || document.activeElement?.tagName);

// The tab and what it reads -------------------------------------------------------------------------

let p = await open(lib);
check("F-208 the pane's tab bar: Details, Files, Library, Computer, Settings", await q(p, () => [...document.querySelectorAll(".tabs .tab")].map((x) => x.textContent.trim()).join() === "Details,Files,Library,Computer,Settings"));
check("E3 the freshness line counts only tasks whose reads both completed: a capped or truncated history isn't counted", (await text(p, "#lib-fresh span")) === "Read 8 of Marlow's 12 tasks in full · checked 5:41 PM");
check("R3 a task read to the history limit, or with a shortened message, says older messages or content weren't read", (await text(p, "#lib-incomplete")) === "Older messages or some message content weren't read in 2 tasks.");
check("F-208 groups Today, This week, Older and Time not read, in that order", await q(p, () => [...document.querySelectorAll(".lib-group h3")].map((h) => h.textContent).join() === "Today,This week,Older,Time not read"));
check("R3 Time not read says only that the time wasn't in the history read", (await text(p, '.lib-group[data-group="unread"] .lib-group-note')) === "The message time wasn't available in the history read.");
check("F-208 five rows a group, then Show 4 more", await q(p, () => document.querySelectorAll('.lib-group[data-group="today"] .lib-row').length === 5 && document.querySelector('[data-lib-more="today"]').textContent === "Show 4 more"));
check("F-208 newest first: the later Trail guide, then the report", await q(p, () => [...document.querySelectorAll('.lib-group[data-group="today"] .lib-row')].slice(0, 2).map((r) => r.dataset.item).join() === "p2,i5"));
check("F-208 a row's second line: type, time, task", (await subOf(p, "p2")) === "Page · 5:37 PM · Saturday's trail plan");
check("F-209 the earlier card of the same page reads Shown again below", (await subOf(p, "p1")) === "Page · 5:33 PM · Shown again below · Saturday's trail plan");
check("F-208 a link's row names its host", (await subOf(p, "k1")) === "trails.example · 5:34 PM · Saturday's trail plan");
check("F-208 the desktop Library lists the bot's items only: the person's uploads and links aren't in it", await q(p, () => !document.querySelector('.lib-row[data-item="u1"], .lib-row[data-item="k5"]')));
check("R3 no row draws a thumbnail: the kind's icon, since no preview bytes are held", await q(p, () => !document.querySelector("#panel-library img, #panel-library .file-thumb")));
await p.click('[data-lib-more="today"]');
check("R8 the last Show more of a group: focus goes to the first row it revealed", await q(p, () => !document.querySelector('[data-lib-more="today"]') && document.activeElement === document.querySelectorAll('.lib-group[data-group="today"] [data-lib-open]')[5]));
check("before looking further, Old trail notes is not listed", await q(p, () => !document.querySelector('.lib-row[data-item="i12"]')));
await p.click('[data-lib="look"]');
check("…and it is announced with the count read in full", (await announced(p)).includes("Read 10 of Marlow's 12 tasks in full"));
await p.click('[data-lib-filter="files"]');
check("F-208 Look in 2 more tasks: every task tried, the line counts those read in full, the foot is gone", (await text(p, "#lib-fresh span")) === "Read 10 of Marlow's 12 tasks in full · checked 5:41 PM" && (await q(p, () => !document.querySelector('[data-lib="look"]') && Boolean(document.querySelector('.lib-row[data-item="i12"]')))));
await p.close();

// Filters -------------------------------------------------------------------------------------------

p = await open(lib);
check("F-208 the filters: All, Pages, Media, Links, Files, Pinned; no Apps", await q(p, () => [...document.querySelectorAll(".lib-filter")].map((x) => x.textContent).join() === "All,Pages,Media,Links,Files,Pinned" && document.querySelector(".lib-filters").getAttribute("role") === "radiogroup"));
await p.focus('[data-lib-filter="all"]');
await p.keyboard.press("ArrowRight");
check("arrows move and choose: Pages lists only pages", await q(p, () => document.activeElement.dataset.libFilter === "pages" && [...document.querySelectorAll(".lib-row")].every((r) => r.dataset.kind === "page")));
check("R3 a Page in a task with no artifacts, on its second history page, is listed", await q(p, () => Boolean(document.querySelector('.lib-group[data-group="older"] .lib-row[data-item="p4"]'))));
await p.click('[data-lib-filter="media"]');
check("Media: pictures, recordings and videos", await q(p, () => [...document.querySelectorAll(".lib-row")].every((r) => ["image", "audio", "video"].includes(r.dataset.kind))));
await p.click('[data-lib-filter="links"]');
check("Links: only links", await q(p, () => [...document.querySelectorAll(".lib-row")].every((r) => r.dataset.kind === "link")));
check("R2 an address with a user name and password, or without a scheme, is no link: not listed", await q(p, () => !document.querySelector('.lib-row[data-item="kx1"], .lib-row[data-item="kx2"]')));
check("E10 the address with a user name and password is built at run time and still carries both", await q(p, () => { const u = new URL(window.CT.library.ITEMS.find((x) => x.id === "kx1").href); return u.username === "user" && u.password === "secret" && u.host === "trails.example"; }));
await p.click('[data-lib-filter="files"]');
check("Files: only files", await q(p, () => [...document.querySelectorAll(".lib-row")].every((r) => r.dataset.kind === "file")));
await p.click('[data-lib-filter="pinned"]');
check("F-208 Pinned lists the pins, newest pin first", await q(p, () => [...document.querySelectorAll(".lib-row")].map((r) => r.dataset.item).join() === "p2,k3,pin:m11:7"));
check("E5 absence only after a complete read of that exact session: Not found in Old trail notes, with Unpin", (await text(p, '.lib-row[data-item="pin:m11:7"] .file-name')) === "Not found in Old trail notes" && (await text(p, '.lib-row[data-item="pin:m11:7"] .file-sub')) === "A complete read of this task found no such message." && (await text(p, '.lib-row[data-item="pin:m11:7"] .lib-unpin')) === "Unpin");
check("R3 Pinned keeps the incomplete-read note", await q(p, () => Boolean(document.querySelector("#lib-incomplete"))));
await p.close();

// Coverage: partial, empty, offline ----------------------------------------------------------------

p = await open(lib + "&lib=loading");
check("loading: skeleton rows, busy, and the line says it is looking", (await q(p, () => Boolean(document.querySelector('#panel-library [aria-busy="true"]')) && document.querySelectorAll("#panel-library .skeleton-row").length === 5)) && (await text(p, "#panel-library .files-fresh span")) === "Looking in Marlow's tasks…");
await p.close();
p = await open(lib + "&lib=partial");
check("R3 two tasks not fully read: the line counts only what was read in full", (await text(p, "#lib-fresh span")) === "Read 6 of Marlow's 12 tasks in full · checked 5:41 PM" && (await text(p, ".lib-failed span")) === "Couldn't fully read 2 tasks.");
check("R3 a task with one failed source keeps what its other source gave: Card ideas, without thank-you.md", await q(p, () => Boolean(document.querySelector('.lib-row[data-item="k6"]')) && !document.querySelector('.lib-row[data-item="i14"]') && !document.querySelector('.lib-row[data-item="i10"]')));
await p.click('[data-lib-filter="pinned"]');
check("R3 the failure line stays under Pinned", (await text(p, ".lib-failed span")) === "Couldn't fully read 2 tasks.");
await p.click('[data-lib-filter="all"]');
await p.click('[data-lib="look"]');
check("R3 looking further announces only the tasks read in full", (await announced(p)).includes("Read 8 of Marlow's 12 tasks in full"));
await p.click('.lib-failed [data-lib="retry"]');
await p.click('[data-lib-filter="files"]');
check("…Try again reads them: the line goes, their rows come", await q(p, () => !document.querySelector(".lib-failed") && Boolean(document.querySelector('.lib-row[data-item="i14"]'))));
await p.close();
p = await open(lib + "&lib=partial&items=none&filter=pages");
check("R3 nothing found in a partial read: No pages in the messages read", (await text(p, "#panel-library .work-empty h4")) === "No pages in the messages read.");
await p.close();
p = await open(lib + "&lib=all&src=complete&items=none&filter=pages");
check("R3 nothing found in a complete read: No pages in the tasks searched", (await text(p, "#panel-library .work-empty h4")) === "No pages in the tasks searched.");
await p.close();
p = await open(lib + "&lib=all&src=complete");
check("E3 every task's reads completed: Read all 12 of Marlow's tasks in full", (await text(p, "#lib-fresh span")) === "Read all 12 of Marlow's tasks in full · checked 5:41 PM" && (await q(p, () => !document.querySelector("#lib-incomplete"))));
await p.close();
p = await open(lib + "&src=history-only");
check("E3 histories that stopped at the limit, with nothing failed, are left out of the count and named", (await text(p, "#lib-fresh span")) === "Read 6 of Marlow's 12 tasks in full · checked 5:41 PM" && (await text(p, "#lib-incomplete")) === "Older messages or some message content weren't read in 4 tasks." && (await q(p, () => !document.querySelector(".lib-failed"))));
await p.close();
p = await open("&width=phone&panel=open&tab=library&src=history-failed&filter=links", phoneSize);
check("E3 on iPhone, the conversation's history didn't answer: its note, and No links in the messages read", (await text(p, ".lib-failed span")) === "Couldn't fully read this conversation." && (await text(p, "#panel-library .work-empty h4")) === "No links in the messages read." && (await q(p, () => !document.querySelector('.lib-row[data-item="k5"]'))));
await p.click('[data-lib-filter="media"]');
check("E3 …the item read still answered: the person's pictures stay", await q(p, () => Boolean(document.querySelector('.lib-row[data-item="u1"]'))));
await p.close();
p = await open("&width=phone&panel=open&tab=library&items=none&filter=media", phoneSize);
check("E3 on iPhone, no media: No media in the items read, since uploads may be missing", (await text(p, "#panel-library .work-empty h4")) === "No media in the items read.");
await p.close();
p = await open(lib + "&lib=error");
check("nothing could be read: the reason and Try again", (await text(p, ".work-empty h4")) === "Couldn't load Marlow's library" && (await text(p, ".work-empty p")) === "The gateway did not answer.");
await p.close();
p = await open(lib + "&lib=offline");
check("R3 connection lost: rows stay, labelled as what was read, no Refresh", (await text(p, "#lib-fresh span")) === "Can't reach the gateway · showing what was read at 5:41 PM" && (await q(p, () => !document.querySelector('[data-lib="refresh"]') && document.querySelectorAll(".lib-row").length > 0)));
check("E3 offline: no Look in more tasks and no Try again, so nothing claims newly read tasks", await q(p, () => !document.querySelector('[data-lib="look"], [data-lib="retry"]')));
await p.click('[data-lib-filter="files"]');
await p.click('[data-lib-open="i7"]');
check("R3 offline, an item not on the device isn't opened: Couldn't reach the gateway", (await text(p, ".lib-failed span")) === "Couldn't reach the gateway. Try again when it's back." && (await q(p, () => window.app.model.selectedTask === "m2")));
await p.close();

p = await open(lib);
let seen = observe(p);
await p.click('[data-lib="refresh"]');
await p.click('[data-lib-filter="pinned"]');
await p.click('[data-lib-filter="all"]');
check("R3 opening and refreshing the Library makes no request for any item or preview", seen.requests.length === 0, seen.requests.join(" "));
await p.click('[data-lib-filter="pages"]');
await p.click('[data-lib-open="p2"]');
await p.waitForTimeout(450);
await p.keyboard.press("Escape");
await q(p, () => window.app.setConnection("offline"));
await p.click('[data-lib-open="p2"]');
await p.waitForTimeout(450);
check("R3 offline, a Page read earlier opens from the device: no second read", (await q(p, () => Boolean(document.querySelector(".page-frame")))) && (await counters(p)).reads === 1);
await p.keyboard.press("Escape");
await p.click('[data-lib-open="p3"]');
await p.waitForTimeout(450);
check("R3 offline, a Page not read yet: Couldn't reach the gateway, nothing read", (await text(p, ".page-state")) === "Couldn't reach the gateway. Try again when it's back." && (await counters(p)).reads === 1);
await p.close();

// Pins ----------------------------------------------------------------------------------------------

p = await open(lib);
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
check("F-208 Pin: busy until the gateway's preferences are read back", await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-busy") === "true" && !document.querySelector('.lib-row[data-item="i5"] .lib-pinmark')));
await p.waitForTimeout(450);
check("…then the mark, pressed, and Pinned announced", (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "true")) && (await announced(p)).includes("Pinned trail-report.md"));
await q(p, () => window.CT.library.prefsChanged());
check("R6 the change event this device's own write causes: read, the same value, nothing announced", !(await announced(p)).includes("Pins changed"));
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("Unpin the same way", (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false")) && (await announced(p)).includes("Unpinned trail-report.md"));
await p.click('[data-lib-filter="pinned"]');
await q(p, () => window.CT.library.prefsChanged());
check("R6 an event with no change: nothing announced", !(await announced(p)).includes("Pins changed"));
await q(p, () => document.querySelector('[data-libbar="other"]').click());
check("R6 another device's change: read, it differs, the list follows and Pins changed is announced", (await q(p, () => document.querySelector(".lib-row").dataset.item === "i8")) && (await announced(p)).includes("Pins changed"));
await p.close();

p = await open(lib + "&pins=none");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("R6 unpinning the last pin deletes the key, and its absence is read back", (await q(p, () => window.CT.library.G.value === null && window.CT.library.P.confirmed === null)) && (await announced(p)).includes("Unpinned trail-report.md"));
await p.close();

p = await open(lib + "&pinfail=conflict");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("R6 a conflict: read the key, apply the one change once, read back: pinned, and the other device's pin kept", (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "true" && window.CT.library.G.value.some((pin) => pin.art === "i8") && window.CT.library.G.value.some((pin) => pin.art === "i5"))) && (await announced(p)).includes("Pinned trail-report.md"));
await p.close();
p = await open(lib + "&pinfail=conflict2");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("R6 a second conflict: not pinned, and the line says the pins kept changing", (await text(p, ".lib-failed span")) === "Couldn't pin: Marlow's pins kept changing on the gateway. Try again." && (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false")));
await p.close();
for (const [fail, committed] of [
  ["noanswer-before", false],
  ["noanswer-after", true],
]) {
  p = await open(lib + `&pinfail=${fail}`);
  await p.hover('.lib-row[data-item="i5"]');
  await p.click('[data-lib-pin="i5"]');
  await p.waitForTimeout(450);
  const during = await q(p, () => ({ line: document.querySelector('.lib-failed[role="status"] span')?.textContent, pressed: document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed"), value: JSON.stringify(window.CT.library.G.value) }));
  await q(p, () => window.app.setConnection("connected"));
  await p.waitForTimeout(100);
  const after = await q(p, () => ({ pressed: document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed"), value: JSON.stringify(window.CT.library.G.value), line: document.querySelector(".lib-failed span")?.textContent ?? "" }));
  check(
    `R6 no answer (${committed ? "after" : "before"} the gateway wrote it): the last confirmed mark and "Couldn't confirm", then on reconnect a read, never a resend`,
    during.line === "Couldn't confirm this pin change. Checking when the gateway is back." && during.pressed === "false" && after.value === during.value && after.pressed === String(committed) && (committed ? (await announced(p)).includes("Pinned trail-report.md") : after.line === "This item isn't pinned on the gateway. Try again."),
  );
  await p.close();
}
p = await open(lib + "&pinfail=noanswer-after");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
await q(p, () => {
  // Another client removes the pin that did reach the gateway, before this device reconnects.
  window.CT.library.G.value = window.CT.library.G.value.filter((pin) => pin.art !== "i5");
  window.__before = JSON.stringify(window.CT.library.G.value);
  window.app.setConnection("connected");
});
await p.waitForTimeout(100);
check("E5 a write that reached the gateway and was removed again before reconnect: the read says it isn't pinned, claims no cause, and nothing is resent", (await text(p, ".lib-failed span")) === "This item isn't pinned on the gateway. Try again." && (await q(p, () => JSON.stringify(window.CT.library.G.value) === window.__before && document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false")));
await p.close();
p = await open(lib + "&pinfail=noanswer-before&pinread=fail");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
await q(p, () => window.app.setConnection("connected"));
await p.waitForTimeout(100);
check("E5 the read on reconnect doesn't answer either: still Couldn't confirm, the last confirmed mark kept", (await text(p, '.lib-failed[role="status"] span')) === "Couldn't confirm this pin change. Checking when the gateway is back." && (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false")));
await p.close();
p = await open(lib + "&pinfail=limit");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
await p.waitForTimeout(450);
check("the profile's 128 settings used: says so", (await text(p, ".lib-failed span")) === "Couldn't pin: the gateway keeps at most 128 of your settings, and they are used.");
await p.close();
p = await open(lib + "&pins=full");
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
check("pins full: nothing sent, and how to make room, with no number of pins", (await text(p, ".lib-failed span")) === "Marlow's pins are full. Unpin one to pin this.");
await p.close();
p = await open(lib + "&pins=none&filter=pinned");
check("nothing pinned: says where pins are kept", (await text(p, "#panel-library .work-empty h4")) === "Nothing pinned" && (await text(p, "#panel-library .work-empty p")) === "Pin an item to keep it here. Pins are kept on the gateway, for every connection on your profile.");
await p.close();
p = await open(lib + "&pins=device&filter=pinned");
check("no preferences for this connection: pins kept on this device, and the list says so", (await text(p, "#lib-pin-where")) === "Kept on this device only: the gateway keeps no preferences for this connection.");
await p.close();
p = await open(lib + "&pins=verify&filter=pinned");
const unresolved = (key) => q(p, (k) => [document.querySelector(`.lib-row[data-item="${k}"] .file-name`)?.textContent, document.querySelector(`.lib-row[data-item="${k}"] .file-sub`)?.textContent], key);
check("E5 a pin whose source read failed: Couldn't verify, never Not found", JSON.stringify(await unresolved("pin:m12:2")) === JSON.stringify(["Couldn't verify this pinned item", "Draft for the club site couldn't be read."]));
check("E5 a pin whose task key now holds another session: Couldn't verify", JSON.stringify(await unresolved("pin:m10:2")) === JSON.stringify(["Couldn't verify this pinned item", "Recipe for the potluck now holds a different session from the one pinned."]));
check("E5 a pin whose sequence now names a different message: Couldn't verify", JSON.stringify(await unresolved("pin:m9:4")) === JSON.stringify(["Couldn't verify this pinned item", "The message at this place in Birthday card verse is a different one now."]));
check("E5 a pin a complete exact-session read doesn't hold: Not found", (await unresolved("pin:m11:7"))[0] === "Not found in Old trail notes");
check("E5 the ordinary pin still resolves to its row", await q(p, () => Boolean(document.querySelector('.lib-row[data-item="p2"] [data-lib-open="p2"]'))));
await p.close();
p = await open(lib + "&lib=partial&filter=pinned");
await q(p, () => {
  window.CT.library.G.value = ["k6", "i14", "i10"];
  window.CT.library.prefsChanged();
});
check("E5 known pins whose sources failed resolve through the same reads: Card ideas listed, the other two unverified", await q(p, () => [...document.querySelectorAll(".lib-row")].map((r) => `${r.dataset.item}:${r.dataset.unresolved || "row"}`).join() === "k6:row,pin:m8:3:true,pin:m6:3:true"));
await p.close();
p = await open(lib + "&state=readonly");
check("read-only: pins as the gateway keeps them are shown", await q(p, () => document.querySelector('[data-lib-pin="p2"]').getAttribute("aria-pressed") === "true"));
await p.hover('.lib-row[data-item="i5"]');
await p.click('[data-lib-pin="i5"]');
check("read-only: Pin gives the access bar, focus on Request access, nothing pinned", (await text(p, ".lib-access .shelf-text")) === "Read-only. Pinning needs permission to change things on the gateway." && (await q(p, () => document.querySelector('[data-lib-pin="i5"]').getAttribute("aria-pressed") === "false" && document.activeElement.dataset.access === "request")));
await p.click('[data-access="request"]');
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

// Links ---------------------------------------------------------------------------------------------

p = await open(lib + "&filter=links");
await p.click('[data-lib-open="k2"]');
check("a link: the confirmation, host first, the full address, Opens in your browser", (await text(p, ".lib-confirm h2")) === "newsletter.example" && (await text(p, ".confirm-address")) === "https://newsletter.example/archive" && (await text(p, ".confirm-where")) === "Opens in your browser.");
await p.keyboard.press("Escape");
check("…Escape cancels, nothing opened, focus back on the row", await q(p, () => !document.querySelector(".lib-confirm") && document.activeElement.dataset.libOpen === "k2" && window.CT.library.opened.length === 0));
await p.click('[data-lib-open="k7"]');
check("R2 a row whose address is cut to fit: the confirmation, never a direct open", await q(p, () => Boolean(document.querySelector(".lib-confirm")) && window.CT.library.opened.length === 0 && document.querySelector('.lib-row[data-item="k7"] .file-name').scrollWidth > document.querySelector('.lib-row[data-item="k7"] .file-name').clientWidth));
await p.click('[data-cf="open"]');
check("R2 Open hands over exactly the address that was displayed", await q(p, () => window.CT.library.opened.at(-1) === "https://newsletter.example/issues/2026/november/neighborhood-intro-draft-with-photos-and-the-long-list-of-events" && document.activeElement.dataset.libOpen === "k7"));
await p.click('[data-lib-open="k1"]');
check("R2 even a row titled with its own address confirms first: its title is cut to fit", await q(p, () => Boolean(document.querySelector(".lib-confirm")) && window.CT.library.opened.length === 1));
await p.keyboard.press("Escape");
await p.close();

p = await open(lib);
await q(p, () => {
  window.app.bots.find((x) => x.id === "marlow").name = "<em>Mar</em>low";
  window.CT.library.rerender();
});
check("R2 a bot's name is text: angle brackets shown, no element made", await q(p, () => !document.querySelector("#panel-library em") && document.querySelector("#lib-fresh span").textContent.includes("<em>Mar</em>low's")));
await q(p, () => {
  window.app.bots.find((x) => x.id === "marlow").name = "Marlow";
  window.CT.library.ITEMS.push({ id: "px", task: "m2", kind: "page", title: "<b>Guide</b> & <i>more</i>", doc: "packing-list", time: "5:38 PM", day: 0, seq: 19, src: "history" });
  window.CT.openPage("px");
});
check("R2 a Page's title is text in the bar and the dialog's name", await q(p, () => !document.querySelector("#page-title b, #page-title i") && document.querySelector("#page-title").textContent === "<b>Guide</b> & <i>more</i>"));
await p.close();
p = await open("");
check("E7 a preview's name with quotes and angle brackets is its exact accessible name, with no element made", await q(p, () => {
  const box = document.createElement("div");
  box.innerHTML = window.CT.library.pic("#000", "#fff", 'Map "north" <b>side</b>')();
  return box.querySelector("svg").getAttribute("aria-label") === 'Map "north" <b>side</b>' && !box.querySelector("b");
}));
await p.close();
p = await open("&bot=juniper&task=j2&panel=open&tab=computer");
await q(p, () => {
  window.app.bots.find((x) => x.id === "juniper").name = "<em>Jun</em>iper";
  window.app.openTask("juniper", "j2");
  window.app.setTab("computer");
});
await p.waitForTimeout(200);
check("E7 the Computer tab writes a bot's name as text too", await q(p, () => !document.querySelector("#panel-computer em") && document.querySelector("#panel-computer").textContent.includes("<em>Jun</em>iper")));
await p.close();
p = await open("");
await q(p, () => {
  window.CT.library.PAGES["trail-guide"].html = '<p>Two synthetic links: <a href="http://100.64.0.1/">shared</a> and <a href="http://[::ffff:127.0.0.1]/">mapped</a>.</p>';
  window.CT.library.L.pageCache = {};
  window.CT.openPage("p2");
});
await p.waitForTimeout(500);
for (const [href, warning] of [
  ["http://100.64.0.1/", "This address may be on your own network."],
  ["http://[::ffff:7f00:1]/", "This address points to this device."],
]) {
  await p.click('[data-pv="links"]');
  await p.click(`.page-links [data-href="${href}"]`);
  check(`E7 a Links address under the written-host rule (${href}): the confirmation with its warning, and nothing handed over before Open`, (await text(p, ".confirm-warning")) === warning && (await text(p, ".confirm-address")) === href && (await q(p, () => window.CT.library.opened.length === 0)));
  await p.keyboard.press("Escape");
}
await p.close();

// The Page, full window -----------------------------------------------------------------------------

p = await open(lib + "&filter=pages");
seen = observe(p);
await p.click('[data-lib-open="p2"]');
check("F-209 a Page opens full window, a dialog named by its title, focus on Close", await q(p, () => document.querySelector(".page-view")?.getAttribute("role") === "dialog" && document.querySelector("#page-title").textContent === "Trail guide" && document.activeElement.dataset.pv === "close"));
check("…loading first", await q(p, () => document.querySelector("#page-stage").getAttribute("aria-busy") === "true" && document.querySelector(".page-state").textContent === "Loading Trail guide…"));
await p.waitForTimeout(450);
check("F-209 the bar: type, bot, task and time", (await text(p, ".page-title span")) === "Page · Marlow · Saturday's trail plan · 5:37 PM");
check("the note says what is not shown and that controls change only this view", (await text(p, "#page-note-text")) === "Shown without its 3 scripts. Parts that need them don't work here. Links aren't followed here. Checkboxes, menus and folded sections change only this view.");
const srcdoc = await q(p, () => document.querySelector(".page-frame").getAttribute("srcdoc"));
const sandbox = await q(p, () => document.querySelector(".page-frame").getAttribute("sandbox"));
check(
  "R1 the frame: sandbox with no permissions; no script, link, form, frame, refresh or outside address left; the policy with form-action and base-uri first",
  sandbox === "" && !/<(script|a|form|iframe|link|base|object|embed)[\s>]|\shref=|\saction=|http-equiv="refresh"|https?:\/\//i.test(srcdoc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")) && srcdoc.includes(`<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'">`),
);
check("R1 a PNG picture the address decision allows stays; an outside picture and an SVG labelled as data go, their alt text left", /id="pixel" src="data:image\/png;base64,/.test(srcdoc) && /<img id="remote" alt="Map of the routes">/.test(srcdoc) && /<img id="badtype" alt="Badge">/.test(srcdoc));
check("R1 the form is unwrapped and its submit button can submit nothing", !/<form/i.test(srcdoc) && /<button type="button" id="go">/.test(srcdoc) && /id="note"/.test(srcdoc));
const frame = pageFrame(p);
await frame.click("text=park's conditions page");
await frame.check("#dry");
await frame.selectOption("#sort", "Climb");
await frame.fill("#note", "early start");
await frame.press("#note", "Enter");
await frame.click("#go");
await frame.click("summary");
await frame.click("text=the hut's booking page");
await frame.press("#go", "Enter");
await p.waitForTimeout(300);
check("F-374 a checkbox, a menu, a field and a folded section change the view", (await frame.isChecked("#dry")) && (await frame.inputValue("#sort")) === "Climb" && (await frame.getAttribute("details", "open")) !== null);
check("a link's words stay as plain text, and a click on them leaves the Page in place", (await frame.evaluate(() => !document.querySelector("a") && [...document.querySelectorAll("span")].some((s) => s.textContent === "park's conditions page"))) && Boolean(pageFrame(p)));
check("R1 the Trail guide fixture made no network requests, navigated no frame, opened no window, by pointer and by keyboard", seen.requests.length === 0 && seen.navigations.length === 0 && seen.popups === 0 && seen.dialogs === 0, JSON.stringify(seen));
check("E1 the rendering walk, counted apart: one read, one parse, one frame, zero requests, zero frame navigations", await q(p, () => JSON.stringify(window.CT.library.counters) === '{"reads":1,"parses":1,"mounts":1}') && seen.requests.length === 0 && seen.navigations.length === 0, JSON.stringify(seen));
await p.click('[data-pv="links"]');
check("R2 Links (3): the full canonical addresses; no user name and password, no relative address", await q(p, () => [...document.querySelectorAll(".page-links .menu-item")].map((x) => x.textContent).join() === "https://trails.example/conditions,https://maps.example/ridge,http://localhost:8080/admin"));
await p.keyboard.press("ArrowDown");
check("R8 the Links menu moves with the arrows", (await q(p, () => document.activeElement.textContent)) === "https://maps.example/ridge");
await p.keyboard.press("End");
check("R8 …and End", (await q(p, () => document.activeElement.textContent)) === "http://localhost:8080/admin");
await p.keyboard.press("Enter");
check("R2 a link on this device, chosen from Links: the confirmation with the device warning, nothing opened", (await text(p, ".confirm-warning")) === "This address points to this device." && (await q(p, () => window.CT.library.opened.length === 0)));
await p.keyboard.press("Escape");
check("R8 …Escape cancels it, and focus is back on Links", (await focused(p)) === "links");
await p.click('[data-pv="links"]');
await p.click('.page-links [data-href="https://trails.example/conditions"]');
check("R2 a public link from Links, whose whole address is the item's text, opens directly", await q(p, () => window.CT.library.opened.at(-1) === "https://trails.example/conditions" && !document.querySelector(".lib-confirm")));
check("the chat is the task's, its field holds the words about the page", (await text(p, ".page-chat-head strong")) === "Saturday's trail plan" && (await q(p, () => document.querySelector("#page-chat-input").value === "About the page “Trail guide”: ")));
await p.click("#page-chat-input");
await p.keyboard.press("End");
await p.keyboard.type("is the ridge path open?");
await p.click('[data-pv="send"]');
check(
  "R7 sending from the side chat uses the conversation's own send: the same text in the task's transcript and the side chat, the draft emptied in both",
  await q(p, () => {
    const t = [...document.querySelectorAll("#transcript .turn[data-role='user'] .bubble")].at(-1)?.textContent;
    const side = [...document.querySelectorAll("#page-chat-log .msg[data-role='user'] .bubble")].at(-1)?.textContent;
    return t === "About the page “Trail guide”: is the ridge path open?" && side === t && window.app.model.drafts.m2 === "" && document.querySelector("#page-chat-input").value === "";
  }),
);
await p.focus('[data-pv="close"]');
await p.keyboard.press("Escape");
check("Escape closes the Page; focus returns to the row", await q(p, () => !document.querySelector(".page-view") && document.activeElement.dataset.libOpen === "p2"));
await p.click('[data-lib-open="p2"]');
await p.waitForTimeout(450);
const again = pageFrame(p);
check("F-374 opened again, the Page is read as it is then, earlier changes to controls discarded", !(await again.isChecked("#dry")) && (await again.inputValue("#sort")) === "Distance");
await p.keyboard.press("Escape");
await p.click('[data-lib-open="p3"]');
await p.waitForTimeout(450);
check("R1 a Library row of another task: that task is made active before its Page is read, and the chat is its", await q(p, () => window.app.model.selectedTask === "m3" && document.querySelector(".page-chat-head strong").textContent === "Packing list for the hut"));
await p.close();

// R1: the gate, at every entry point ---------------------------------------------------------------

for (const [label, query, act] of [
  ["a Library row", lib + "&filter=pages&gate=closed", (p) => p.click('[data-lib-open="p2"]')],
  ["a conversation card", "&gate=closed", (p) => p.click("#card-p1 .artifact-main")],
  ["the media viewer's former page route", "&gate=closed&bot=juniper&task=j2&viewer=page", async () => {}],
]) {
  p = await open(query);
  seen = observe(p);
  await act(p);
  await p.waitForTimeout(500);
  const c = await counters(p);
  check(
    `R1 before this platform's check passes, ${label} opens the Page view with no frame, no parse and no read`,
    c.reads === 0 && c.parses === 0 && c.mounts === 0 && (await q(p, () => !document.querySelector(".page-frame, .viewer") && document.querySelector(".page-view")?.dataset.state === "unavailable")) && (await text(p, ".page-state strong")) === "Clawtrate can't show pages here yet.",
  );
  if (label === "a Library row") {
    check("R1 …and says what can be done", (await text(p, ".page-state p:nth-child(2)")) === "You can export this page as a file, or ask Marlow about it in the chat.");
    await p.click('[data-pv="export"]');
    check("R5 Export, chosen there: Reading Trail guide from the gateway…", (await text(p, "#export-body")) === "Reading Trail guide from the gateway…");
    await p.waitForTimeout(400);
    const after = await counters(p);
    check("R1 only Export reads and parses the entrypoint, and still nothing is drawn", after.reads === 1 && after.parses === 1 && after.mounts === 0 && seen.requests.length === 0);
    check("R5 not drawn here, the first choice is the Clawtrate version", await q(p, () => [...document.querySelectorAll(".export-choice strong")].map((x) => x.textContent).join() === "Clawtrate version,As Marlow made it"));
  }
  await p.close();
}
for (const size of [{ width: 1440, height: 900 }, phoneSize]) {
  for (const [label, query, act] of [
    ["its Page card", "&bot=juniper&task=j2", (p) => p.click("#card-page .artifact-main")],
    ["its legacy query", "&bot=juniper&task=j2&viewer=page", async () => {}],
  ]) {
    const w = await b.newPage({ viewport: size });
    w.on("pageerror", (e) => out.push("PAGEERROR " + e));
    await w.goto(pageUrl("work.html") + "?chrome=0&theme=light" + query + (size.width === 390 ? "&width=phone" : ""));
    await w.waitForTimeout(200);
    await act(w);
    await w.waitForTimeout(300);
    check(
      `E1 the standalone Work page at ${size.width}, ${label}: the viewer fails closed with no Page content, frame or library read`,
      await w.evaluate(() => document.querySelector(".viewer .viewer-closed")?.textContent === "Clawtrate can't show pages here yet." && !document.querySelector(".viewer-page, iframe, .page-frame") && !window.CT.library),
    );
    if (label === "its Page card") {
      await w.keyboard.press("Escape");
      check(`E1 …at ${size.width}, Close returns focus to the card`, await w.evaluate(() => !document.querySelector(".viewer") && document.activeElement.closest("#card-page") !== null));
    }
    await w.close();
  }
}
for (const [id, words] of [
  ["ps", "Clawtrate couldn't confirm this page in Saturday's trail plan."],
  ["pm", "This is an app view. It needs scripts, which Clawtrate doesn't run."],
]) {
  p = await open("");
  await q(p, (i) => window.CT.openPage(i), id);
  await p.waitForTimeout(500);
  await p.keyboard.press("Meta+e");
  await p.keyboard.press("Control+e");
  await q(p, () => document.querySelector('[data-pv="export"]').click());
  check(
    `E1 an occurrence the transcript doesn't confirm (${id === "ps" ? "a stale view id" : "an app view"}): unavailable, and Export reads nothing`,
    (await text(p, ".page-state strong")) === words && JSON.stringify(await counters(p)) === '{"reads":0,"parses":0,"mounts":0}' && (await q(p, () => !document.querySelector(".export-dialog") && document.querySelector('[data-pv="export"]').disabled)),
  );
  await p.close();
}
p = await open("&bot=juniper&task=j2&viewer=page");
await p.waitForTimeout(500);
check("R1 the media viewer's former page route opens the Page view, never the viewer's frame", await q(p, () => Boolean(document.querySelector(".page-view .page-frame")) && !document.querySelector(".viewer")));
await p.close();
p = await open("&page=trail-guide&gate=closed&exportread=failed&export=open");
await p.waitForTimeout(500);
await p.click('[data-pv="export"]');
await p.waitForTimeout(400);
check("R5 a read for export that fails says so in the dialog, with Try again", (await text(p, "#export-body .export-one")) === "Couldn't read Trail guide from the gateway. The gateway said: Canvas widget unavailable; reload the chat or ask the agent to recreate it." && (await q(p, () => document.activeElement.dataset.ex === "retry")));
await p.close();

// Page states ---------------------------------------------------------------------------------------

p = await open("&page=packing-list");
await p.waitForTimeout(500);
check("a Page without scripts: the note says only what applies", (await text(p, "#page-note-text")) === "Links aren't followed here. Checkboxes, menus and folded sections change only this view.");
await p.close();
p = await open("&page=trail-guide-1");
await p.waitForTimeout(500);
check("F-209 the earlier card's Page opens the same Page as it is now", (await text(p, ".page-title span")) === "Page · Marlow · Saturday's trail plan · 5:33 PM" && (await q(p, () => /forest track/i.test(document.querySelector(".page-frame").getAttribute("srcdoc")))));
await p.close();
p = await open("&page=trail-guide&pageload=failed");
await p.waitForTimeout(500);
check("the gateway refused: its words, Try again, and nothing to export", (await text(p, ".page-state p:nth-child(2)")) === "The gateway said: Canvas widget unavailable; reload the chat or ask the agent to recreate it." && (await q(p, () => document.querySelector('[data-pv="export"]').disabled)));
await p.keyboard.press("Control+e");
await p.keyboard.press("Meta+e");
check("R5 ⌘E on a Page that didn't load does what the disabled button does: nothing", await q(p, () => !document.querySelector(".export-dialog")));
await p.click('[data-pv="retry"]');
await p.waitForTimeout(500);
check("…Try again shows the Page", await q(p, () => Boolean(document.querySelector(".page-frame")) && !document.querySelector('[data-pv="export"]').disabled));
await p.close();
p = await open("&page=trail-guide&pageload=large");
await p.waitForTimeout(500);
check("larger than Clawtrate shows: says so with the limit", (await text(p, ".page-state")) === "Trail guide is larger than Clawtrate shows (5 MiB).");
await p.close();

// R7: access inside the active surface, and drafts ----------------------------------------------------

p = await open("&page=trail-guide&state=readonly");
await p.waitForTimeout(500);
check("E6 read-only: the side chat draws the task's own transcript, and Request access in the composer's place", (await text(p, ".page-chat-readonly span")) === "Read-only: messages can't be sent from this device." && (await q(p, () => { const side = [...document.querySelectorAll("#page-chat-log .bubble")].map((b) => b.textContent); const conv = [...document.querySelectorAll("#transcript .turn .bubble")].map((b) => b.textContent).slice(-side.length); return !document.querySelector("#page-chat-input") && side.length > 0 && JSON.stringify(side) === JSON.stringify(conv) && !document.querySelector("#page-chat-log button, #page-chat-log a, #page-chat-log [id]"); })));
await p.click('[data-pv="pin"]');
check("R7 Pin in a read-only Page: the access request inside the Page view, focused", await q(p, () => document.querySelector(".page-view").contains(document.activeElement) && document.activeElement.dataset.access === "request" && !document.querySelector("#panel-library .lib-access")));
await p.click('[data-access="request"]');
await p.waitForTimeout(400);
check("R7 …it goes on to waiting for the owner, still inside the Page view", (await text(p, "#page-access .shelf-text")).startsWith("Waiting for the gateway's owner."));
await q(p, () => window.CT.library.owner("deny"));
check("R7 …denied: said there, with Request again", (await text(p, "#page-access .shelf-text")) === "The request was denied. Nothing changed. This device can still read." && (await q(p, () => document.activeElement.dataset.access === "request" && document.querySelector(".page-view").contains(document.activeElement))));
await p.close();
p = await open("&page=trail-guide&state=readonly");
await p.waitForTimeout(500);
await p.click('[data-pv="request-access"]');
await p.waitForTimeout(400);
check("R7 Request access from the side chat doesn't stall: waiting for the owner, inside the Page view", (await text(p, "#page-access .shelf-text")).startsWith("Waiting for the gateway's owner."));
await q(p, () => window.CT.library.owner("approve"));
check("R7 …approved: the composer appears in the side chat", await q(p, () => Boolean(document.querySelector("#page-chat-input"))) && (await announced(p)).includes("Access granted"));
check("E6 …approved from Chat: focus is in the composer, and nothing was pinned", await q(p, () => document.activeElement.id === "page-chat-input" && window.CT.library.G.value.length === 3));
await p.close();
p = await open("&page=trail-guide&state=readonly");
await p.waitForTimeout(500);
await p.click('[data-pv="pin"]');
await p.click('[data-access="request"]');
await p.waitForTimeout(400);
await q(p, () => window.CT.library.owner("approve"));
check("E6 approved from Pin: focus returns to Pin, which waits to be chosen again; nothing written", await q(p, () => document.activeElement.dataset.pv === "pin" && document.activeElement.getAttribute("aria-pressed") === "true" && window.CT.library.G.value.length === 3));
await p.close();
p = await open("&page=trail-guide");
await p.waitForTimeout(600);
await q(p, () => window.app.setConnection("reconnecting"));
await p.fill("#page-chat-input", "A queued message from the Page");
await p.press("#page-chat-input", "Enter");
check("E6 queued offline with Enter: the same pending turn in the conversation and the side chat", await q(p, () => {
  const conv = document.querySelector('#transcript [data-waiting="true"] .bubble')?.textContent;
  const side = document.querySelector('#page-chat-log [data-waiting="true"] .bubble')?.textContent;
  return conv === "A queued message from the Page" && side === conv && document.querySelector("#page-chat-log").textContent.includes("Sends when reconnected");
}));
await q(p, () => window.app.setConnection("syncing"));
await p.waitForTimeout(1300);
check("E6 …reconnected: the same confirmed turn in both, and the waiting label gone from both", await q(p, () => {
  const side = document.querySelector("#page-chat-log").textContent;
  return !document.querySelector('#transcript [data-waiting="true"], #page-chat-log [data-waiting="true"]') && !side.includes("Sends when reconnected") && side.includes("A queued message from the Page") && document.querySelector("#transcript").textContent.includes("A queued message from the Page");
}));
await p.close();

p = await open("");
await q(p, () => (window.app.model.drafts.m2 = "Remember the snacks"));
await q(p, () => window.CT.openPage("p2"));
await p.waitForTimeout(500);
check("R7 a draft already in the task: Replace your draft?, focus on Keep draft", (await text(p, "#draft-title")) === "Replace your draft?" && (await focused(p)) === "Keep draft");
await p.keyboard.press("Escape");
check("R7 …Escape keeps it, in the side chat and the conversation alike", await q(p, () => document.querySelector("#page-chat-input").value === "Remember the snacks" && window.app.model.drafts.m2 === "Remember the snacks" && document.activeElement.id === "page-chat-input"));
await p.click('[data-pv="chat"]');
await p.click('[data-pv="chat"]');
await p.click('[data-dr="replace"]');
check("R7 …Replace draft puts the words about the page in its place", await q(p, () => document.querySelector("#page-chat-input").value === "About the page “Trail guide”: " && window.app.model.drafts.m2 === "About the page “Trail guide”: "));
await p.close();

// The page card in the conversation -----------------------------------------------------------------

p = await open("");
check("F-209 two cards of one Page: the earlier one reads Shown again below", await q(p, () => document.querySelector("#card-p1 .artifact-sub").textContent === "Page · Shown again below" && document.querySelector("#card-p2 .artifact-sub").textContent === "Page"));
await q(p, () => (document.querySelector("#transcript").scrollTop = 20));
await p.click("#card-p1 .artifact-main");
await p.waitForTimeout(450);
check("the card's Open opens the Page view, not the media viewer", await q(p, () => Boolean(document.querySelector(".page-view")) && !document.querySelector(".viewer")));
await p.keyboard.press("Escape");
check("R8 closing returns to the card, the transcript where it was", await q(p, () => document.activeElement.closest("#card-p1") !== null && document.querySelector("#transcript").scrollTop === 20));
await p.close();

// Export --------------------------------------------------------------------------------------------

p = await open("&page=trail-guide");
await p.waitForTimeout(500);
await p.focus('[data-pv="export"]');
await p.keyboard.press("Meta+e");
check("F-210 Export: As shown here, chosen first, and As Marlow made it", await q(p, () => [...document.querySelectorAll(".export-choice strong")].map((x) => x.textContent).join() === "As shown here,As Marlow made it" && document.querySelector('input[value="shown"]').checked));
const exportText = await text(p, ".export-card");
check("R5 it says what each file holds, that the original can run scripts or contact other sites, and that only the HTML is in either", exportText.includes("Saves the Clawtrate version, with scripts, navigable controls and outside references removed.") && exportText.includes("Saves the original HTML. When opened, it can run scripts or contact other sites.") && exportText.includes("Both files contain the page's HTML only: files kept beside it on the gateway aren't included. The file is saved on this device; Clawtrate uploads nothing."));
check("F-210 nothing calls the file safe, private or shared", !/\b(safe|safely|private|secure|shared)\b/i.test(exportText));
let [download] = await Promise.all([p.waitForEvent("download"), p.click('[data-ex="save"]')]);
let saved = await readFile(await download.path(), "utf8");
check("F-210 Save… writes Trail guide.html as shown: no script, no link address", download.suggestedFilename() === "Trail guide.html" && !/<script/i.test(saved) && !/href=/i.test(saved));
check("E2 …a browser download: Download started is announced, never Exported, and the dialog closes with focus on Export…", (await announced(p)) === "Download started: Trail guide.html" && (await q(p, () => !document.querySelector(".export-dialog") && document.activeElement.dataset.pv === "export")));
await p.close();

p = await open("&page=packing-list");
await p.waitForTimeout(500);
await p.click('[data-pv="export"]');
check("R5 a Page without scripts still gets the choice: its two files differ", await q(p, () => document.querySelectorAll(".export-choice").length === 2));
[download] = await Promise.all([p.waitForEvent("download"), p.click('[data-ex="save"]')]);
const shownBytes = await readFile(await download.path(), "utf8");
await p.click('[data-pv="export"]');
await p.check('input[value="raw"]');
[download] = await Promise.all([p.waitForEvent("download"), p.click('[data-ex="save"]')]);
const rawBytes = await readFile(await download.path(), "utf8");
check("R5 the two downloads are the bytes described: the Clawtrate version without the link's address, the original with it", !shownBytes.includes("hut.example") && rawBytes.includes('href="https://hut.example/rules"') && shownBytes !== rawBytes);
check("E2 each whole file is exactly the version chosen: the framed form, and the gateway's HTML byte for byte", await q(p, ([shown, raw]) => shown === window.CT.library.framedPage(window.CT.library.PAGES["packing-list"].html).html && raw === window.CT.library.PAGES["packing-list"].html, [shownBytes, rawBytes]));
check("E2 a style naming an outside address is not in the Clawtrate version, image-set included", await q(p, () => { const f = window.CT.library.framedPage('<style>p { background-image: image-set("https://styles.example/sample.png" 1x); }</style><p style="background:url(//styles.example/a.png)">A short page</p>').html; return !f.includes("styles.example") && f.includes("A short page"); }));
await p.close();

p = await open("");
await q(p, () => {
  window.CT.library.ITEMS.push({ id: "pt", task: "m2", kind: "page", title: "../Trips/Saturday: guide", doc: "packing-list", time: "5:39 PM", day: 0, seq: 20, src: "history" });
  window.CT.openPage("pt");
});
await p.waitForTimeout(500);
await p.click('[data-pv="export"]');
[download] = await Promise.all([p.waitForEvent("download"), p.click('[data-ex="save"]')]);
check("R5 a title with path separators gives one name ending .html; the title stays as shown", download.suggestedFilename() === "Saturday- guide.html" && (await text(p, "#page-title")) === "../Trips/Saturday: guide");
await p.close();

p = await open("&page=trail-guide&export=open&exportfail=1");
await p.waitForTimeout(500);
await p.click('[data-ex="save"]');
check("the system refuses the file: the dialog stays and says why", (await text(p, ".export-error")) === "Couldn't save Trail guide.html. The system said: there is not enough space on the disk." && (await q(p, () => Boolean(document.querySelector(".export-dialog")))));
await p.close();

// The iPhone ----------------------------------------------------------------------------------------

p = await open("&width=phone&panel=open&tab=library", phoneSize);
check("F-371 the iPhone's Library is this conversation's", await q(p, () => document.querySelector(".library").dataset.scope === "conversation" && !document.querySelector('.lib-row[data-item="i6"]')));
check("F-371 the line says what was searched: this conversation", (await text(p, "#lib-fresh span")) === "In this conversation · checked 5:41 PM");
check("R4 it says some uploads may be missing", (await text(p, "#lib-uploads")) === "Some uploads may be missing.");
await p.click('[data-lib-more="today"]');
await p.click('[data-lib-more="today"]');
check("R8 at phone width too, the last Show more focuses the first row it revealed", await q(p, () => !document.querySelector('[data-lib-more="today"]') && document.activeElement === document.querySelectorAll('.lib-group[data-group="today"] [data-lib-open]')[10]));
check("E4 five metadata rows the person sent, four from the image listing's first reply and one after its cursor, each Preview unavailable", await q(p, () => ["u1", "u2", "u3", "u4", "u5"].every((id) => document.querySelector(`.lib-row[data-item="${id}"] .file-sub`)?.textContent === "PNG image · Preview unavailable · 5:29 PM · sent by you" && document.querySelector(`[data-lib-open="${id}"]`).getAttribute("aria-disabled") === "true") && window.CT.library.ITEMS.filter((x) => x.src === "uploads").map((x) => x.cursor).join() === "1,1,1,1,2"));
check("R4 sent by you only where the matching history row is the person's", (await subOf(p, "k5")) === "maps.example · 5:30 PM · sent by you");
const uploadSeen = observe(p);
for (const id of ["u1", "u5"]) {
  await q(p, (i) => document.querySelector(`[data-lib-open="${i}"]`).click(), id);
  check(`E4 choosing ${id === "u1" ? "the first" : "the fifth"} opens no viewer and offers no Download, Copy or Share, and says why`, (await text(p, ".lib-failed span")) === `Can't open map-${id.slice(1)}.png here: the gateway didn't return its picture.` && (await q(p, () => !document.querySelector(".viewer, [data-v=download], [data-v=copy], .export-dialog") && !window.CT.work.artifacts.u1)));
}
check("E4 …and no request was made", uploadSeen.requests.length === 0, uploadSeen.requests.join(" "));
await p.focus('[data-lib-open="u1"]');
await p.keyboard.press("Shift+F10");
check("E4 Shift+F10 on an upload row: no menu, no error, focus stays on the row", await q(p, () => !document.querySelector(".lib-hold") && document.activeElement.dataset.libOpen === "u1" && document.querySelector('[data-lib-open="u1"]').getAttribute("aria-haspopup") === null));
await p.click('[data-lib-filter="pinned"]');
check("R6 the iPhone's Pinned lists this conversation's pins only", await q(p, () => [...document.querySelectorAll(".lib-row")].map((r) => r.dataset.item).join() === "p2"));
await p.click('[data-lib-filter="links"]');
await p.click('[data-lib-open="k1"]');
check("R2 a link on the iPhone: the confirmation says Opens outside Clawtrate", (await text(p, ".confirm-where")) === "Opens outside Clawtrate.");
await p.click('[data-cf="cancel"]');
check("…Cancel: focus back on the row", (await focused(p)) === "k1");
await p.close();
p = await open("&width=phone&panel=open&tab=library&items=none&filter=links", phoneSize);
check("R4 nothing found on the iPhone: scoped to this conversation", (await text(p, "#panel-library .work-empty h4")) === "No links in this conversation.");
await p.close();

p = await open("&width=phone&panel=open&tab=library", phoneSize);
const rowBox = await p.locator('[data-lib-open="p2"]').boundingBox();
await p.mouse.move(rowBox.x + 60, rowBox.y + 20);
await p.mouse.down();
await p.waitForTimeout(650);
await p.mouse.up();
await p.waitForTimeout(150);
check("R8 a real touch and hold: the menu opens, and the release opens nothing", await q(p, () => Boolean(document.querySelector(".lib-hold")) && !document.querySelector(".page-sheet")));
check("F-372 the Page row's menu: Open, Share as file…, Unpin; no Copy Link, no Open in Web", await q(p, () => [...document.querySelectorAll(".lib-hold .menu-item")].map((x) => x.textContent).join() === "Open,Share as file…,Unpin"));
await p.keyboard.press("ArrowDown");
check("R8 the menu moves with the arrows", (await focused(p)) === "Share as file…");
await p.keyboard.press("Escape");
check("R8 Escape closes it, focus back on the row", await q(p, () => !document.querySelector(".lib-hold") && document.activeElement.dataset.libOpen === "p2"));
await q(p, async () => {
  // A completed hold whose release lands off its row, so no click belongs to it.
  const row = document.querySelector('[data-lib-open="p2"]');
  row.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 7, clientX: 60, clientY: 20 }));
  await new Promise((r) => setTimeout(r, 600));
  document.body.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 7 }));
});
await p.keyboard.press("Escape");
await p.click('[data-lib-filter="links"]');
check("E8 after a hold released off its row and dismissed, the next ordinary click still acts", await q(p, () => !document.querySelector(".lib-hold") && document.querySelector('[data-lib-filter="links"]').getAttribute("aria-checked") === "true"));
await p.click('[data-lib-filter="all"]');
await p.mouse.move(rowBox.x + 60, rowBox.y + 20);
await p.mouse.down();
await p.mouse.move(rowBox.x + 60, rowBox.y + 60, { steps: 4 });
await p.waitForTimeout(650);
await p.mouse.up();
check("R8 a press that moves is a scroll: no menu", await q(p, () => !document.querySelector(".lib-hold")));
await p.focus('[data-lib-open="p2"]');
await p.keyboard.press("Shift+F10");
check("R8 the same menu from a keyboard", await q(p, () => Boolean(document.querySelector(".lib-hold")) && document.activeElement.dataset.hold === "open"));
await p.keyboard.press("Enter");
check("F-373 a Page on iPhone: the unavailable state full screen, nothing of the Page read, parsed or drawn", (await text(p, ".page-sheet-lead")) === "Clawtrate for iPhone can't show pages yet." && (await q(p, () => !document.querySelector(".page-sheet iframe") && !/Lake loop/.test(document.querySelector(".page-sheet").innerText))) && JSON.stringify(await counters(p)) === '{"reads":0,"parses":0,"mounts":0}');
await p.click('[data-ps="share"]');
await p.waitForTimeout(400);
check("R5 Share as file… on iPhone reads the entrypoint only now, then offers the same choice", (await counters(p)).reads === 1 && (await q(p, () => document.querySelector(".export-dialog [data-ex='save']").textContent === "Share…")));
await p.click('[data-ex="cancel"]');
check("R8 closing it returns focus to Share as file…", (await focused(p)) === "Share as file…");
await p.click('[data-ps="share"]');
await p.waitForTimeout(400);
await p.click('[data-ex="save"]');
check(
  "R5 Share… hands the system's share sheet the chosen bytes under one name, and says only that the sheet opened",
  (await q(p, () => {
    const h = window.CT.library.handoffs.at(-1);
    return h.name === "Trail guide.html" && h.type === "text/html" && h.via === "share-sheet" && !/<script/i.test(h.bytes) && h.bytes.includes("Content-Security-Policy");
  })) && (await announced(p)) === "Share sheet opened with Trail guide.html",
);
await p.click('[data-ps="message"]');
check("F-373 Message about: the sheet closes, the composer holds the words, caret after them", await q(p, () => !document.querySelector(".page-sheet") && document.activeElement.classList.contains("composer-input") && document.activeElement.value === "About the page “Trail guide”: "));
await p.close();
p = await open("&width=phone&panel=open&tab=library", phoneSize);
await p.focus('[data-lib-open="p2"]');
await p.keyboard.press("Shift+F10");
await p.click('.lib-hold [data-hold="share"]');
check("E2 Share as file… from a Page row's menu opens Share for that Page over the Library, reading now and drawing nothing", (await text(p, "#export-title")) === "Share Trail guide" && (await q(p, () => document.querySelector(".shell").inert && document.querySelector('[data-ex="save"]').disabled)));
await p.waitForTimeout(400);
check("E2 …one read, no frame, and Save enabled by that read", JSON.stringify(await counters(p)) === '{"reads":1,"parses":1,"mounts":0}' && (await q(p, () => !document.querySelector('[data-ex="save"]').disabled)));
await p.click('[data-ex="cancel"]');
check("E2 …Cancel returns focus to the row, and the Library is usable again", await q(p, () => document.activeElement.dataset.libOpen === "p2" && !document.querySelector(".shell").inert));
await p.focus('[data-lib-open="p2"]');
await p.keyboard.press("Shift+F10");
await p.click('.lib-hold [data-hold="share"]');
await p.waitForTimeout(400);
await p.click('[data-ex="save"]');
check("E2 …Share… hands over that occurrence's chosen bytes", await q(p, () => { const h = window.CT.library.handoffs.at(-1); return h.name === "Trail guide.html" && h.bytes === window.CT.library.framedPage(window.CT.library.PAGES["trail-guide"].html).html; }));
await p.close();
p = await open("&width=phone&page=trail-guide", phoneSize);
await p.waitForTimeout(200);
await q(p, () => {
  document.querySelector('[data-ps="share"]').click();
  document.querySelector('[data-ex="cancel"]').click();
  document.querySelector('[data-ps="close"]').click();
  window.CT.openPage("p3");
  document.querySelector('[data-ps="share"]').click();
});
await p.waitForTimeout(150);
check("E2 a read cancelled with its dialog doesn't fill the next one: Packing list's Save stays disabled until its own reply", (await text(p, "#export-title")) === "Share Packing list" && (await q(p, () => document.querySelector('[data-ex="save"]').disabled && !document.querySelector(".export-dialog")._files)));
await p.waitForTimeout(350);
check("E2 …then the Packing list's own bytes, and none of Trail guide's", await q(p, () => { const f = document.querySelector(".export-dialog")._files; return !document.querySelector('[data-ex="save"]').disabled && f.raw.includes("Packing list") && !f.raw.includes("Trail guide"); }));
await p.close();
p = await open("&width=phone&page=trail-guide&sharefail=1", phoneSize);
await p.waitForTimeout(200);
await p.click('[data-ps="share"]');
await p.waitForTimeout(400);
await p.click('[data-ex="save"]');
check("R5 the share sheet refused: said in the dialog, which stays, and nothing handed over", (await text(p, ".export-error")) === "Couldn't open the share sheet. The system said: sharing isn't available right now." && (await q(p, () => window.CT.library.handoffs.length === 0 && Boolean(document.querySelector(".export-dialog")))));
await p.close();
p = await open("&width=phone&page=trail-guide", phoneSize);
await q(p, () => (window.app.model.drafts.m2 = "Bring the map"));
await p.waitForTimeout(200);
await p.click('[data-ps="message"]');
check("R7 Message about with a draft already there: Replace your draft?", (await text(p, "#draft-title")) === "Replace your draft?");
await p.click('[data-dr="keep"]');
check("R7 …Keep draft: the composer holds the person's draft, unchanged", await q(p, () => document.activeElement.classList.contains("composer-input") && document.activeElement.value === "Bring the map"));
await p.close();
p = await open("&width=phone&panel=open&tab=library&state=readonly&hold=i2", phoneSize);
check("touch and hold another item: Open and Pin", await q(p, () => [...document.querySelectorAll(".lib-hold .menu-item")].map((x) => x.textContent).join() === "Open,Pin"));
await p.click('[data-hold="pin"]');
check("R6 at phone width, read-only Pin opens the access request and changes nothing on the gateway", await q(p, () => document.activeElement.dataset.access === "request" && window.CT.library.G.value.length === 3 && !window.CT.library.G.value.some((pin) => pin.art === "i2")));
await p.close();
p = await open("&width=phone&panel=open&tab=library", phoneSize);
await p.focus('[data-lib-filter="all"]');
await p.keyboard.press("Escape");
check("E8 Escape with only the phone's Work pane open is the pane's own: it closes", await q(p, () => window.app.model.panel === false && !document.querySelector(".lib-hold, .page-view, .page-sheet, .export-dialog")));
await p.close();
p = await open("&width=phone&panel=open&tab=library&lib=error", phoneSize);
check("F-371 the iPhone's library couldn't load: its words and Try Again", (await text(p, "#panel-library .work-empty h4")) === "Couldn't load this conversation's library" && (await text(p, '#panel-library [data-lib="retry"]')) === "Try Again");
await p.close();

// Widths, keyboard and screen readers ---------------------------------------------------------------

for (const [label, query, size] of [
  ["800", "&page=trail-guide", { width: 800, height: 760 }],
  ["a desktop window 390 wide", "&width=phone&device=desktop&page=trail-guide", phoneSize],
]) {
  p = await open(query, size);
  await p.waitForTimeout(500);
  check(`at ${label}: the frame takes the width, the chat starts hidden`, await q(p, () => document.querySelector(".page-view").classList.contains("chat-hidden") && document.querySelector('[data-pv="chat"]').getAttribute("aria-pressed") === "false"));
  await p.click('[data-pv="chat"]');
  check(`…Chat opens it as a drawer, focus in its field`, await q(p, () => getComputedStyle(document.querySelector(".page-chat")).position === "absolute" && document.activeElement.id === "page-chat-input"));
  await p.click('[data-pv="chat-close"]');
  check(`R8 …its own Close hides it and returns focus to Chat`, await q(p, () => document.querySelector(".page-view").classList.contains("chat-hidden") && document.activeElement.dataset.pv === "chat"));
  await p.close();
}

p = await open("&page=trail-guide");
await p.waitForTimeout(500);
const order = [];
for (let i = 0; i < 9; i += 1) {
  order.push(await q(p, () => (document.activeElement.tagName === "IFRAME" ? "frame" : document.activeElement.dataset.pv || document.activeElement.id || document.activeElement.tagName)));
  await p.keyboard.press("Tab");
  if (order.at(-1) === "frame") {
    // Inside the frame, Tab walks the Page's own controls; Shift+Tab from its first control comes back out.
    break;
  }
}
check("R8 Tab order: Close, Export, Pin, Chat, Links, then the frame", order.slice(0, 6).join() === "close,export,pin,chat,links,frame", order.join());
await pageFrame(p).focus("#dry");
await p.keyboard.press("Shift+Tab");
await p.keyboard.press("Shift+Tab");
check("R8 from a control inside the Page, Shift+Tab leaves the frame to the bar's side", await q(p, () => document.activeElement.tagName !== "IFRAME" && document.querySelector(".page-view").contains(document.activeElement)));
await p.keyboard.press("Escape");
check("R8 …and Escape then closes the Page", await q(p, () => !document.querySelector(".page-view")));
await p.close();

p = await open("&page=trail-guide&export=open");
await p.waitForTimeout(500);
await p.keyboard.press("Shift+Tab");
await p.keyboard.press("Shift+Tab");
await p.keyboard.press("Shift+Tab");
check("R8 Tab stays in the topmost dialog: Export's, not the Page view under it", await q(p, () => document.querySelector(".export-dialog").contains(document.activeElement)));
await p.keyboard.press("Escape");
check("R8 Escape closes Export only, focus back on what opened it", await q(p, () => Boolean(document.querySelector(".page-view")) && !document.querySelector(".export-dialog") && document.activeElement.dataset.pv === "close"));
await p.close();

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
