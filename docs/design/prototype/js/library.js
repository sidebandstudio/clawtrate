// The Library and Pages, on local fixtures. docs/design/library.md is the
// specification. This file wraps the extension work.js sets (CT.appExtension):
// it adds Marlow's tasks, fills the Library tab, opens a Page full window with
// its chat, exports a Page, and draws the iPhone's forms at phone width.
// No gateway, no network: a Page's HTML is framed exactly as section 6 says,
// so it makes no request.
//
// States from the address (library.md, section 12):
//   ?panel=open&tab=library&bot=marlow&task=m2
//   ?filter=all|pages|media|links|files|pinned
//   ?lib=loading|partial|error|empty|offline|all
//   ?pins=device|full|none   ?pinfail=conflict|noanswer|limit   ?exportfail=1
//   ?page=trail-guide|trail-guide-1|packing-list   ?pageload=failed|large|offline   ?chat=hidden   ?export=open
//   ?info=library (phone)   ?hold=<item id> (phone)   ?device=desktop (phone width, the desktop app)
//   ?state=readonly

(function () {
  const CT = window.CT;
  const W = CT.work;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const pinIcon = () =>
    `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/></svg>`;
  let app = null;
  const phone = () => document.documentElement.dataset.input === "touch" && params.get("device") !== "desktop";

  // Fixtures ---------------------------------------------------------------------------------------
  // Today is Thursday, November 19. day: days before today. Monday the 16th starts the week.

  const pic = (a, b, label) => () =>
    `<svg viewBox="0 0 640 400" role="img" aria-label="${label}"><rect width="640" height="400" fill="${a}"/>` +
    `<path d="M0 320 L160 180 L280 260 L420 120 L640 300 L640 400 L0 400Z" fill="${b}"/></svg>`;

  // Marlow's tasks, newest activity first. at: minutes for the rail's order.
  const MARLOW = [
    ["m2", "Saturday's trail plan", 1057, "5:37 PM", 0],
    ["m1", "Main", 1018, "4:58 PM", 0],
    ["m3", "Packing list for the hut", -2, "Tue", 2],
    ["m4", "Neighborhood newsletter intro", -3, "Mon", 3],
    ["m5", "Spring reading list", -7, "Nov 12", 7],
    ["m6", "Ridge photos", -10, "Nov 9", 10],
    ["m7", "Cover letter opening", -13, "Nov 6", 13],
    ["m8", "Thank-you note", -15, "Nov 4", 15],
    ["m9", "Birthday card verse", -20, "Oct 30", 20],
    ["m10", "Recipe for the potluck", -24, "Oct 26", 24],
    ["m11", "Old trail notes", -30, "Oct 20", 30],
    ["m12", "Draft for the club site", -38, "Oct 12", 38],
  ];
  const taskTitle = (id) => (MARLOW.find((m) => m[0] === id) || [])[1] || app?.bots.flatMap((b) => b.tasks).find((t) => t.id === id)?.title || id;

  // Every occurrence: kind page|image|audio|video|file|link. by: who sent it (the phone lists the person's too).
  const ITEMS = [
    { id: "i1", task: "m2", kind: "file", title: "trail-report.md", type: "Markdown", size: "149 B", time: "5:31 PM", day: 0, seq: 4 },
    { id: "i2", task: "m2", kind: "image", title: "ridge-profile.png", type: "PNG image", size: "1.2 KB", time: "5:31 PM", day: 0, seq: 4 },
    { id: "i3", task: "m2", kind: "image", title: "trail-photo.png", type: "PNG image", size: "408 KB", time: "5:31 PM", day: 0, seq: 4 },
    { id: "i4", task: "m2", kind: "audio", title: "trail-chime.wav", type: "WAV audio", size: "31 KB", time: "5:31 PM", day: 0, seq: 4 },
    { id: "p1", task: "m2", kind: "page", title: "Trail guide", doc: "trail-guide", time: "5:33 PM", day: 0, seq: 8, again: true },
    { id: "k1", task: "m2", kind: "link", title: "https://trails.example/conditions", href: "https://trails.example/conditions", time: "5:34 PM", day: 0, seq: 10 },
    { id: "i5", task: "m2", kind: "file", title: "trail-report.md", type: "Markdown", size: "149 B", time: "5:36 PM", day: 0, seq: 14 },
    { id: "p2", task: "m2", kind: "page", title: "Trail guide", doc: "trail-guide", time: "5:37 PM", day: 0, seq: 18 },
    { id: "u1", task: "m2", kind: "image", title: "map-screenshot.png", type: "PNG image", size: "96 KB", time: "5:29 PM", day: 0, seq: 1, by: "person" },
    { id: "i6", task: "m1", kind: "file", title: "newsletter-intro.md", type: "Markdown", size: "2.1 KB", time: "4:58 PM", day: 0, seq: 6 },
    { id: "p3", task: "m3", kind: "page", title: "Packing list", doc: "packing-list", time: "2:10 PM", day: 2, seq: 4 },
    { id: "i7", task: "m3", kind: "file", title: "packing.csv", type: "CSV", size: "2 KB", time: "2:10 PM", day: 2, seq: 4 },
    { id: "i8", task: "m4", kind: "image", title: "header.png", type: "PNG image", size: "180 KB", time: "11:20 AM", day: 3, seq: 6 },
    { id: "k2", task: "m4", kind: "link", title: "Newsletter archive", href: "https://newsletter.example/archive", time: "11:20 AM", day: 3, seq: 6 },
    { id: "i9", task: "m5", kind: "file", title: "reading-list.md", type: "Markdown", size: "3.4 KB", time: "Nov 12", day: 7, seq: 380 },
    { id: "k3", task: "m5", kind: "link", title: "Spring picks", href: "https://books.example/spring", time: "Nov 12", day: 7, seq: 380 },
    { id: "i13", task: "m5", kind: "file", title: "first-draft.md", type: "Markdown", size: "5.0 KB", day: null, seq: 12 },
    { id: "i10", task: "m6", kind: "video", title: "ridge-walk.mp4", type: "MP4 video", size: "12 MB", time: "Nov 9", day: 10, seq: 3 },
    { id: "i11", task: "m6", kind: "image", title: "ridge-dawn.jpg", type: "JPEG image", size: "640 KB", time: "Nov 9", day: 10, seq: 3 },
    { id: "i12", task: "m11", kind: "file", title: "old-route.md", type: "Markdown", size: "88 B", time: "Oct 20", day: 30, seq: 5 },
    { id: "k4", task: "m12", kind: "link", title: "Club site draft", href: "https://club.example/draft", time: "Oct 12", day: 38, seq: 2 },
  ];
  const item = (id) => ITEMS.find((x) => x.id === id);

  // The pages: their HTML as the gateway sends it (scripts, links and all).
  const PAGES = {
    "trail-guide": {
      title: "Trail guide",
      html:
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trail guide</title>` +
        `<script src="https://cdn.example/chart.js"></script>` +
        `<style>body{font:15px/1.5 system-ui,sans-serif;margin:28px 32px;color:#111213;background:#fff}h1{font-size:24px;margin:0 0 4px}` +
        `table{border-collapse:collapse;width:100%;margin-top:14px}th,td{padding:9px 8px;border-bottom:1px solid #e2e2df;text-align:left}` +
        `.chart{height:120px;border:1px dashed #c9c9c5;border-radius:10px;margin-top:14px;display:grid;place-items:center;color:#8a8b8e}` +
        `a{color:#0a6e5c}label{margin-right:14px}</style></head><body>` +
        `<h1>Trail guide</h1><p>Saturday's routes, with what to expect on each. See the <a href="https://trails.example/conditions">park's conditions page</a> before you leave.</p>` +
        `<p><label><input type="checkbox" id="dry"> Only dry routes</label><label>Sort by <select id="sort"><option>Distance</option><option>Climb</option></select></label></p>` +
        `<table><thead><tr><th>Route</th><th>Distance</th><th>Climb</th><th>Ground</th></tr></thead><tbody>` +
        `<tr><td>Lake loop</td><td>6 km</td><td>40 m</td><td>Dry</td></tr><tr><td>Ridge path</td><td>11 km</td><td>520 m</td><td>Muddy below the saddle</td></tr>` +
        `<tr><td>Forest track</td><td>8 km</td><td>180 m</td><td>Dry</td></tr></tbody></table>` +
        `<div class="chart" id="chart">Elevation chart</div>` +
        `<details><summary>Getting there</summary><p>Park at the north lot; the first bus is at 7:10. <a href="https://maps.example/ridge">Map of the ridge</a></p></details>` +
        `<script>document.getElementById('dry').onchange=()=>{fetch('https://trails.example/track?dry=1')}</script>` +
        `<script>new Chart(document.getElementById('chart'))</script></body></html>`,
    },
    "packing-list": {
      title: "Packing list",
      html:
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Packing list</title>` +
        `<style>body{font:15px/1.6 system-ui,sans-serif;margin:28px 32px;color:#111213;background:#fff}h1{font-size:24px;margin:0 0 8px}li{list-style:none}</style></head><body>` +
        `<h1>Packing list for the hut</h1><ul><li><label><input type="checkbox"> Sleeping bag liner</label></li><li><label><input type="checkbox"> Head torch</label></li>` +
        `<li><label><input type="checkbox"> Hut slippers</label></li><li><label><input type="checkbox"> Cash for the warden</label></li></ul></body></html>`,
    },
    "ebook-apps": {
      title: "E-book apps compared",
      html:
        `<!doctype html><html><head><title>E-book apps compared</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:28px 32px;color:#111213;background:#fff}td,th{padding:8px;text-align:left;border-bottom:1px solid #e2e2df}</style></head><body>` +
        `<h1>E-book apps compared</h1><table><tr><th>App</th><th>Titles</th><th>Typical wait</th></tr><tr><td>Shelfwise</td><td>48,000</td><td>9 days</td></tr>` +
        `<tr><td>PageLoop</td><td>31,000</td><td>14 days</td></tr><tr><td>Readmore</td><td>22,000</td><td>6 days</td></tr></table>` +
        `<script>sortable(document.querySelector('table'))</script></body></html>`,
    },
  };

  /**
   * A Page's HTML for the frame (library.md, section 6): parsed aside, every
   * element and attribute that could make a request taken out, the no-load
   * policy first in its head. The frame around it is sandbox="".
   */
  const REMOVE = "script, base, meta[http-equiv], link, iframe, frame, object, embed, portal";
  const DROP = ["href", "xlink:href", "action", "formaction", "target", "ping"];
  const DATA_ONLY = ["src", "srcset", "poster", "data", "background"];
  const POLICY = "default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'; font-src data:";
  function framedPage(html) {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const scripts = doc.querySelectorAll("script").length;
    const links = [...doc.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => /^https?:\/\//i.test(h));
    doc.querySelectorAll(REMOVE).forEach((el) => el.remove());
    // A link keeps its words, as plain text in the surrounding style: no longer an <a>, so no link style applies.
    for (const a of doc.querySelectorAll("a")) {
      const span = doc.createElement("span");
      span.append(...a.childNodes);
      a.replaceWith(span);
    }
    for (const el of doc.querySelectorAll("*")) {
      DROP.forEach((name) => el.removeAttribute(name));
      DATA_ONLY.forEach((name) => {
        if (el.hasAttribute(name) && !/^data:/i.test(el.getAttribute(name))) el.removeAttribute(name);
      });
    }
    const meta = doc.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = POLICY;
    doc.head.prepend(meta);
    return { html: `<!doctype html>${doc.documentElement.outerHTML}`, scripts, links: [...new Set(links)] };
  }
  CT.framedPage = framedPage;

  // State ------------------------------------------------------------------------------------------

  const L = {
    filter: params.get("filter") || "all",
    lib: params.get("lib") || "loaded",
    read: params.get("lib") === "all" ? 99 : 10,
    shown: {},
    pinStore: params.get("pins") === "device" ? "device" : "gateway",
    pins: { marlow: params.get("pins") === "none" ? [] : ["p2", "k3", "gone:m11"] },
    full: params.get("pins") === "full",
    busy: new Set(),
    pinError: null,
    pinFail: params.get("pinfail"),
    access: null, // the access bar's state while asking for the interactive tier
    accessFor: null,
  };
  const canWrite = () => app && app.model.access === "write";
  const pinsOf = (botId) => (L.pins[botId] ||= []);
  const isPinned = (botId, id) => pinsOf(botId).includes(id);

  // Which items a bot's Library lists: its tasks newest first, the first `read` of them.
  function tasksOf(b) {
    return [...b.tasks].sort((x, y) => y.at - x.at).map((t) => t.id);
  }
  function itemsFor(b) {
    if (b.id !== "marlow") {
      // The other bots: what work-artifacts.js hands over in their tasks.
      const A = W.artifacts || {};
      const ids = new Set(b.tasks.map((t) => t.id));
      const rows = Object.keys(A)
        .filter((k) => ids.has(A[k].task))
        .map((k) => ({ id: k, task: A[k].task, kind: A[k].kind, title: A[k].name, type: A[k].typeWords, size: W.size(A[k].size), time: A[k].time, day: 0, seq: 1, fromWork: true }));
      if (b.id === "juniper") rows.unshift({ id: "pj", task: "j2", kind: "page", title: "E-book apps compared", doc: "ebook-apps", time: "3:02 PM", day: 0, seq: 2 });
      return rows;
    }
    return ITEMS.filter((x) => x.by !== "person");
  }
  function readTasks(b) {
    const all = tasksOf(b);
    return { all, read: all.slice(0, Math.min(L.read, all.length)) };
  }

  // A time of day as minutes, for the order inside a day; a date alone sorts by its day.
  const minutes = (x) => {
    const m = /^(\d+):(\d+) (AM|PM)$/.exec(x.time || "");
    return m ? ((+m[1] % 12) + (m[3] === "PM" ? 12 : 0)) * 60 + +m[2] : 0;
  };
  const groupOf = (x) => (x.day === null ? "unread" : x.day === 0 ? "today" : x.day <= 3 ? "week" : "older");
  const GROUPS = [
    ["today", "Today"],
    ["week", "This week"],
    ["older", "Older"],
    ["unread", "Time not read"],
  ];
  const FILTERS = [
    ["all", "All"],
    ["pages", "Pages"],
    ["media", "Media"],
    ["links", "Links"],
    ["files", "Files"],
    ["pinned", "Pinned"],
  ];
  const matches = (x, f) =>
    f === "all" ? true : f === "pages" ? x.kind === "page" : f === "media" ? ["image", "audio", "video"].includes(x.kind) : f === "links" ? x.kind === "link" : f === "files" ? x.kind === "file" : true;
  const kindIcon = (k) => ({ page: "page", image: "image", audio: "audio", video: "video", file: "file", link: "link" })[k] || "file";
  const host = (href) => new URL(href).host;

  function sub(x) {
    const parts = x.kind === "page" ? ["Page"] : x.kind === "link" ? [host(x.href)] : [x.type, x.size].filter(Boolean);
    if (x.time) parts.push(x.time);
    if (x.again) parts.push("Shown again below");
    parts.push(taskTitle(x.task));
    return parts.join(" · ");
  }

  // The Library tab ---------------------------------------------------------------------------------

  function row(b, x) {
    const pinned = isPinned(b.id, x.id);
    const busy = L.busy.has(x.id);
    const spoken = `${x.title}, ${x.kind === "page" ? "Page" : x.kind === "link" ? `link, ${host(x.href)}` : x.type}, in ${taskTitle(x.task)}${x.time ? `, ${x.time}` : ""}${x.again ? ", shown again below" : ""}${pinned ? ", pinned" : ""}. Open.`;
    const pinLabel = `${pinned ? "Unpin" : "Pin"} ${x.title}`;
    return (
      `<li class="lib-row" data-item="${x.id}" data-kind="${x.kind}"><button type="button" class="file-row" data-lib-open="${x.id}" aria-label="${esc(spoken)}" title="${esc(x.title)}">` +
      `<span class="file-icon">${icon(kindIcon(x.kind))}</span><span class="file-name">${esc(x.title)}${pinned ? `<span class="lib-pinmark" aria-hidden="true">${pinIcon()}</span>` : ""}</span>` +
      `<span class="file-sub">${esc(sub(x))}</span></button>` +
      `<button type="button" class="icon-button lib-pin" data-variant="quiet" data-lib-pin="${x.id}" aria-pressed="${pinned}" aria-label="${esc(pinLabel)}" title="${pinned ? "Unpin" : "Pin"}"${busy ? ' aria-busy="true" disabled' : ""}>${pinIcon()}</button></li>`
    );
  }

  function freshness(b, tasks, conv) {
    if (L.lib === "loading") return `<div class="files-fresh" role="status"><span>Looking in ${b.name}'s tasks…</span></div>`;
    const lost = L.lib === "offline" || app?.model.connection === "offline" || app?.model.connection === "reconnecting";
    const where = conv ? "In this conversation" : tasks.read.length >= tasks.all.length ? `In all ${tasks.all.length} of ${b.name}'s tasks` : `In ${b.name}'s ${tasks.read.length} most recent tasks of ${tasks.all.length}`;
    return (
      `<div class="files-fresh" role="status" id="lib-fresh"><span>${lost ? `Can't reach the gateway · checked 5:41 PM` : `${where} · checked 5:41 PM`}</span>` +
      (lost ? "" : `<button type="button" class="icon-button" data-variant="quiet" data-lib="refresh" aria-label="Refresh the library" title="Refresh">${icon("retry")}</button>`) +
      `</div>`
    );
  }

  function accessBar() {
    const s = L.access;
    if (!s) return "";
    const text =
      s === "asking"
        ? `${CT.glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`
        : s === "requested"
          ? `${CT.glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine: <code>openclaw devices approve 7c41d09e</code>. This changes by itself as soon as the owner approves or denies the request, or it expires.</span>`
          : `${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${L.accessFor === "chat" ? "Messaging" : "Pinning"} needs permission to change things on the gateway.</span>` +
            `<button type="button" class="button" data-size="sm" data-variant="primary" data-lib="request-access">Request access</button>`;
    return `<section class="access-bar lib-access" role="region" aria-label="Access" data-state="${s}"><div class="access-row">${text}</div></section>`;
  }

  function renderLibrary(b, t) {
    const panel = $("#panel-library");
    if (!panel) return;
    const keep = document.activeElement && panel.contains(document.activeElement) ? keyOf(document.activeElement) : null;
    const conv = phone() && t; // the iPhone: this conversation's library
    const tasks = conv ? { all: [t.id], read: [t.id] } : readTasks(b);
    let items = conv ? ITEMS.filter((x) => x.task === t.id) : itemsFor(b).filter((x) => tasks.read.includes(x.task));
    if (L.lib === "partial") items = items.filter((x) => !["m5", "m6"].includes(x.task));
    if (L.lib === "empty") items = [];
    const filters =
      `<div class="lib-filters" role="radiogroup" aria-label="Show">` +
      FILTERS.map(([k, label]) => `<button type="button" class="lib-filter" role="radio" aria-checked="${L.filter === k}" tabindex="${L.filter === k ? 0 : -1}" data-lib-filter="${k}">${label}</button>`).join("") +
      `</div>`;
    let body = "";
    if (L.lib === "loading") {
      body = `<div class="files" aria-busy="true" aria-label="Loading the library">${'<div class="skeleton-row"></div>'.repeat(5)}</div>`;
    } else if (L.lib === "error") {
      body =
        `<div class="work-empty" role="alert"><span class="empty-mark">${CT.glyph("failed")}</span><h4>Couldn't load ${conv ? "this conversation's" : `${b.name}'s`} library</h4>` +
        `<p>The gateway did not answer.</p><button type="button" class="button" data-size="sm" data-lib="retry">${conv ? "Try Again" : "Try again"}</button></div>`;
    } else if (L.filter === "pinned") {
      body = pinnedList(b);
    } else {
      const shown = items.filter((x) => matches(x, L.filter));
      if (!shown.length) body = empty(b, tasks, conv);
      else {
        body = GROUPS.map(([g, word]) => {
          const rows = shown.filter((x) => groupOf(x) === g).sort((a, c) => (a.day ?? 99) - (c.day ?? 99) || minutes(c) - minutes(a) || c.seq - a.seq);
          if (!rows.length) return "";
          const n = L.shown[g] || 5;
          const more = rows.length - n;
          return (
            `<section class="lib-group" data-group="${g}"><h3 id="lib-h-${g}">${word}</h3>` +
            (g === "unread" ? `<p class="lib-group-note">These are in long tasks, beyond the messages read.</p>` : "") +
            `<ul class="file-list" aria-labelledby="lib-h-${g}">${rows.slice(0, n).map((x) => row(b, x)).join("")}</ul>` +
            (more > 0 ? `<button type="button" class="lib-more" data-lib-more="${g}">Show ${Math.min(5, more)} more</button>` : "") +
            `</section>`
          );
        }).join("");
      }
      if (L.lib === "partial")
        body = `<p class="lib-failed" role="alert">${icon("warning")}<span>Couldn't read 2 of the ${tasks.read.length} tasks.</span><button type="button" class="button" data-size="sm" data-lib="retry">Try again</button></p>` + body;
    }
    const foot =
      !conv && !["loading", "error"].includes(L.lib) && tasks.read.length < tasks.all.length && L.filter !== "pinned"
        ? `<button type="button" class="button lib-look" data-size="sm" data-lib="look">Look in ${Math.min(10, tasks.all.length - tasks.read.length)} more tasks</button>`
        : "";
    const note = L.pinError ? `<p class="lib-failed" role="alert">${icon("warning")}<span>${esc(L.pinError)}</span></p>` : "";
    panel.innerHTML = `<div class="library" data-scope="${conv ? "conversation" : "bot"}">${filters}${freshness(b, tasks, conv)}${note}${body}${foot}${accessBar()}</div>`;
    if (keep) restore(keep);
  }

  function empty(b, tasks, conv) {
    const what = { all: null, pages: "pages", media: "pictures, recordings or videos", links: "links", files: "files" }[L.filter];
    const look = !conv && tasks.read.length < tasks.all.length;
    if (!what)
      return `<div class="work-empty"><span class="empty-mark">${icon("tasks")}</span><h4>Nothing found yet</h4><p>Pages, pictures, files and links ${b.name} sends appear here.</p></div>`;
    return `<div class="work-empty"><span class="empty-mark">${icon(kindIcon({ pages: "page", media: "image", links: "link", files: "file" }[L.filter]))}</span><h4>No ${what} in ${conv ? "this conversation" : "these tasks"}.</h4>${look ? "" : ""}</div>`;
  }

  function pinnedList(b) {
    const ids = pinsOf(b.id);
    const where =
      L.pinStore === "device"
        ? `<p class="lib-group-note" id="lib-pin-where">Kept on this device only: the gateway keeps no preferences for this connection.</p>`
        : "";
    if (!ids.length)
      return (
        `<div class="work-empty"><span class="empty-mark">${pinIcon()}</span><h4>Nothing pinned</h4>` +
        `<p>Pin an item to keep it here. Pins are kept ${L.pinStore === "device" ? "on this device" : "on the gateway for every device you use"}.</p></div>`
      );
    const rows = ids
      .map((id) => {
        if (id.startsWith("gone:")) {
          const task = id.slice(5);
          return (
            `<li class="lib-row" data-item="${id}" data-gone="true"><div class="file-row" role="group" aria-label="A pinned item not found in ${esc(taskTitle(task))}"><span class="file-icon">${icon("file")}</span>` +
            `<span class="file-name">Not found in ${esc(taskTitle(task))} any more</span><span class="file-sub">The task no longer holds this message.</span></div>` +
            `<button type="button" class="button lib-unpin" data-size="sm" data-lib-pin="${id}">Unpin</button></li>`
          );
        }
        const x = item(id) || itemsFor(b).find((y) => y.id === id);
        return x ? row(b, x) : "";
      })
      .join("");
    return `<section class="lib-group" data-group="pinned"><h3 id="lib-h-pinned">Pinned</h3>${where}<ul class="file-list" aria-labelledby="lib-h-pinned">${rows}</ul></section>`;
  }

  // Keep focus on the same control across a re-render.
  const keyOf = (el) =>
    el.dataset.libOpen ? `[data-lib-open="${el.dataset.libOpen}"]` : el.dataset.libPin ? `[data-lib-pin="${el.dataset.libPin}"]` : el.dataset.libFilter ? `[data-lib-filter="${el.dataset.libFilter}"]` : el.dataset.libMore ? `more:${el.dataset.libMore}` : el.dataset.lib ? `[data-lib="${el.dataset.lib}"]` : null;
  function restore(key) {
    if (key.startsWith("more:")) {
      const g = key.slice(5);
      const btn = $(`[data-lib-more="${g}"]`);
      if (btn) return btn.focus();
      return $$(`.lib-group[data-group="${g}"] .file-row`).at(-1)?.focus();
    }
    $(key)?.focus();
  }

  const rerender = () => {
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const t = b.tasks.find((x) => x.id === app.model.selectedTask) || null;
    renderLibrary(b, t);
  };
  CT.library = { L, rerender, ITEMS, PAGES, framedPage };

  // Pins ---------------------------------------------------------------------------------------------

  function togglePin(id) {
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const x = item(id) || itemsFor(b).find((y) => y.id === id);
    const name = x ? x.title : "this item";
    const pinned = isPinned(b.id, id);
    L.pinError = null;
    if (!canWrite() && L.pinStore === "gateway") {
      L.access = "read";
      L.accessFor = "pin";
      rerender();
      return $('[data-lib="request-access"]')?.focus();
    }
    if (!pinned && L.full) {
      L.pinError = `${b.name}'s pins are full. Unpin one to pin this.`;
      CT.announce(`Couldn't pin ${name}`);
      return rerender();
    }
    L.busy.add(id);
    rerender();
    setTimeout(() => {
      L.busy.delete(id);
      if (L.pinFail === "conflict") {
        L.pinError = "Couldn't pin: pins changed on another device. Try again.";
        CT.announce(`Couldn't pin ${name}`);
      } else if (L.pinFail === "limit") {
        L.pinError = "Couldn't pin: the gateway keeps at most 128 of your settings, and they are used.";
        CT.announce(`Couldn't pin ${name}`);
      } else if (L.pinFail === "noanswer") {
        L.pinError = "Couldn't pin: no answer from the gateway.";
        CT.announce(`Couldn't pin ${name}`);
      } else {
        // Read back, then show.
        const list = pinsOf(b.id);
        if (pinned) list.splice(list.indexOf(id), 1);
        else list.unshift(id);
        CT.announce(`${pinned ? "Unpinned" : "Pinned"} ${name}`);
      }
      rerender();
      syncPageBar();
    }, 350);
  }

  // The Page view --------------------------------------------------------------------------------------

  let view = null;
  let opener = null;
  let loadFails = params.get("pageload") === "failed";
  const chatShown = () => !view?.classList.contains("chat-hidden");
  const narrow = () => innerWidth < 1000 || document.documentElement.dataset.width === "800" || document.documentElement.dataset.width === "phone";

  function openPage(id, from) {
    const x = item(id) || (id === "pj" ? { id: "pj", task: "j2", kind: "page", title: "E-book apps compared", doc: "ebook-apps", time: "3:02 PM" } : null);
    if (!x) return;
    opener = from || document.activeElement;
    if (phone()) return openPhonePage(x);
    view?.remove();
    const botId = x.task.startsWith("j") ? "juniper" : "marlow";
    const botName = botId === "juniper" ? "Juniper" : "Marlow";
    view = document.createElement("div");
    view.className = "page-view";
    view.setAttribute("role", "dialog");
    view.setAttribute("aria-modal", "true");
    view.setAttribute("aria-labelledby", "page-title");
    view.dataset.item = x.id;
    view.dataset.bot = botId;
    if (params.get("chat") === "hidden" || narrow()) view.classList.add("chat-hidden");
    const pinned = isPinned(botId, x.id);
    view.innerHTML =
      `<header class="page-bar"><button type="button" class="icon-button" data-pv="close" aria-label="Close the page" title="Close (Esc)">${icon("x")}</button>` +
      `<div class="page-title"><strong id="page-title">${esc(x.title)}</strong><span>Page · ${botName} · ${esc(taskTitle(x.task))} · ${x.time}</span></div>` +
      `<button type="button" class="button" data-size="sm" data-pv="export" disabled>Export…</button>` +
      `<button type="button" class="icon-button" data-variant="quiet" data-pv="pin" aria-pressed="${pinned}" aria-label="${pinned ? "Unpin" : "Pin"} ${esc(x.title)}" title="${pinned ? "Unpin" : "Pin"}">${pinIcon()}</button>` +
      `<button type="button" class="icon-button" data-variant="quiet" data-pv="chat" aria-pressed="${!view.classList.contains("chat-hidden")}" aria-label="${view.classList.contains("chat-hidden") ? "Show the chat" : "Hide the chat"}" title="Chat">${icon("message")}</button></header>` +
      `<div class="page-note" id="page-note" hidden></div>` +
      `<div class="page-body"><div class="page-stage" id="page-stage" aria-busy="true"><p class="page-state">Loading ${esc(x.title)}…</p></div>` +
      `<aside class="page-chat" aria-label="Chat about ${esc(x.title)}">${chat(x, botId, botName)}</aside></div>`;
    $(".app").appendChild(view);
    $(".shell").inert = true;
    $('[data-pv="close"]', view).focus();
    setTimeout(() => loadPage(x), 300);
  }

  function loadPage(x) {
    if (!view) return;
    const stage = $("#page-stage");
    const page = PAGES[x.doc];
    stage.removeAttribute("aria-busy");
    if (loadFails) {
      loadFails = false;
      stage.innerHTML =
        `<div class="page-state" role="alert"><p><strong>The gateway couldn't show this page.</strong></p>` +
        `<p>The gateway said: Canvas widget unavailable; reload the chat or ask the agent to recreate it.</p>` +
        `<button type="button" class="button" data-size="sm" data-pv="retry">Try again</button></div>`;
      exportOff("Nothing to export: the page didn't load");
      return;
    }
    if (params.get("pageload") === "offline") {
      stage.innerHTML = `<div class="page-state" role="alert"><p><strong>Can't reach the gateway. Try again when it's back.</strong></p></div>`;
      exportOff("Nothing to export: the page didn't load");
      return;
    }
    if (params.get("pageload") === "large") {
      stage.innerHTML = `<div class="page-state" role="alert"><p><strong>${esc(x.title)} is larger than Clawtrate shows (5 MB).</strong></p></div>`;
      exportOff("Nothing to export: the page didn't load");
      return;
    }
    const framed = framedPage(page.html);
    view._framed = framed;
    view._raw = page.html;
    stage.innerHTML = "";
    const frame = document.createElement("iframe");
    frame.className = "page-frame";
    frame.setAttribute("sandbox", "");
    frame.setAttribute("title", `${x.title}, page`);
    frame.srcdoc = framed.html;
    stage.appendChild(frame);
    const note = $("#page-note");
    const parts = [];
    if (framed.scripts) parts.push(`Shown without its ${framed.scripts} script${framed.scripts === 1 ? "" : "s"}. Parts that need them don't work here.`);
    if (framed.links.length) parts.push("Links aren't followed here.");
    parts.push("Checkboxes, menus and folded sections change only this view.");
    note.innerHTML =
      `<span id="page-note-text">${parts.join(" ")}</span>` +
      (framed.links.length ? `<button type="button" class="link-button" data-pv="links" aria-haspopup="menu" aria-expanded="false">Links (${framed.links.length})</button>` : "");
    note.hidden = false;
    view.setAttribute("aria-describedby", "page-note-text");
    const ex = $('[data-pv="export"]', view);
    ex.disabled = false;
    ex.removeAttribute("title");
    if (params.get("export") === "open") openExport();
  }
  function exportOff(why) {
    const ex = $('[data-pv="export"]', view);
    ex.disabled = true;
    ex.title = why;
  }

  function chat(x, botId, botName) {
    const msgs =
      x.task === "m2"
        ? [
            ["user", "Make me a trail page for Saturday."],
            ["assistant", "I made a page with Saturday's routes."],
            ["user", "Add the forest track too."],
            ["assistant", "Done: the page now has the forest track."],
          ]
        : [
            ["user", "What should I pack for the hut?"],
            ["assistant", "Here is a packing list you can tick off."],
          ];
    const head = `<div class="page-chat-head">${CT.avatar ? CT.avatar(botId) : ""}<strong>${esc(taskTitle(x.task))}</strong></div>`;
    const list = `<div class="page-chat-log" id="page-chat-log">${msgs.map(([r, m]) => `<div class="msg" data-role="${r}"><div class="bubble">${esc(m)}</div></div>`).join("")}</div>`;
    const foot = canWrite()
      ? `<div class="page-chat-composer"><textarea id="page-chat-input" rows="2" aria-label="Message ${botName} in ${esc(taskTitle(x.task))}">About the page “${esc(x.title)}”: </textarea>` +
        `<button type="button" class="icon-button send-button" data-pv="send" aria-label="Send">${icon("arrow-up")}</button></div>`
      : `<section class="access-bar" role="region" aria-label="Access" data-state="read"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> Messaging needs permission to change things on the gateway.</span>` +
        `<button type="button" class="button" data-size="sm" data-variant="primary" data-pv="request-access">Request access</button></div></section>`;
    return head + list + foot;
  }

  function syncPageBar() {
    if (!view) return;
    const pinned = isPinned(view.dataset.bot, view.dataset.item);
    const b = $('[data-pv="pin"]', view);
    const title = $("#page-title").textContent;
    b.setAttribute("aria-pressed", String(pinned));
    b.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${title}`);
  }

  function closePage() {
    if (!view) return;
    closeMenu();
    closeExport();
    view.remove();
    view = null;
    $(".shell").inert = false;
    if (opener && document.contains(opener)) opener.focus();
  }

  // The links a Page names: full addresses; choosing one opens it in the system browser.
  let menu = null;
  function closeMenu() {
    menu?.remove();
    menu = null;
    $('[data-pv="links"]')?.setAttribute("aria-expanded", "false");
  }
  function openLinks(button) {
    if (menu) return closeMenu();
    menu = document.createElement("ul");
    menu.className = "menu page-links";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Links in this page");
    menu.innerHTML = view._framed.links.map((h) => `<li role="none"><button type="button" class="menu-item" role="menuitem" data-pv="open-link" data-href="${esc(h)}">${esc(h)}</button></li>`).join("");
    button.after(menu);
    button.setAttribute("aria-expanded", "true");
    $(".menu-item", menu).focus();
  }

  // Export ---------------------------------------------------------------------------------------------

  let dialog = null;
  function openExport(fromPhone) {
    const framed = view?._framed || framedPage(PAGES[fromPhone.doc].html);
    const raw = view?._raw || PAGES[fromPhone.doc].html;
    const title = view ? $("#page-title").textContent : fromPhone.title;
    const botName = view ? (view.dataset.bot === "juniper" ? "Juniper" : "Marlow") : "Marlow";
    const kb = (s) => `${(new TextEncoder().encode(s).length / 1024).toFixed(1)} KB`;
    dialog?.remove();
    dialog = document.createElement("div");
    dialog.className = "export-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "export-title");
    dialog._files = { shown: framed.html, raw };
    dialog._name = `${title}.html`;
    dialog._phone = Boolean(fromPhone);
    const choice = framed.scripts
      ? `<div role="radiogroup" aria-label="What to export" class="export-choices">` +
        `<label class="export-choice"><input type="radio" name="export" value="shown" checked><span><strong>As shown here</strong>` +
        `<span>The page as Clawtrate shows it: its ${framed.scripts} scripts, its link addresses and anything it would load are taken out. ${kb(framed.html)}.</span></span></label>` +
        `<label class="export-choice"><input type="radio" name="export" value="raw"><span><strong>As ${botName} made it</strong>` +
        `<span>The HTML exactly as the gateway sent it, with its ${framed.scripts} scripts. Opened in a browser, those scripts run with that browser's access, and they can load files from other sites. ${kb(raw)}.</span></span></label></div>`
      : `<p class="export-one">The page as Clawtrate shows it. It has no scripts, so this is also the page as ${botName} made it. ${kb(framed.html)}.</p>`;
    dialog.innerHTML =
      `<div class="export-card"><h2 id="export-title">Export ${esc(title)}</h2>${choice}` +
      `<p class="export-foot">Only the page's HTML: files kept beside it on the gateway aren't included. The file is saved on this device; nothing is uploaded.</p>` +
      `<p class="export-error" role="alert" hidden></p>` +
      `<div class="export-actions"><button type="button" class="button" data-size="sm" data-ex="cancel">Cancel</button>` +
      `<button type="button" class="button" data-size="sm" data-variant="primary" data-ex="save">${fromPhone ? "Share…" : "Save…"}</button></div></div>`;
    (view || $(".app")).appendChild(dialog);
    ($("input:checked", dialog) || $('[data-ex="save"]', dialog)).focus();
  }
  function closeExport() {
    if (!dialog) return;
    dialog.remove();
    dialog = null;
    $('[data-pv="export"]')?.focus();
  }
  function saveExport() {
    const which = $("input:checked", dialog)?.value || "shown";
    const name = dialog._name;
    if (params.get("exportfail") === "1") {
      const err = $(".export-error", dialog);
      err.textContent = `Couldn't save ${name}. The system said: there is not enough space on the disk.`;
      err.hidden = false;
      return;
    }
    if (dialog._phone) {
      CT.toast(`The system's share sheet opens with ${name}.`);
      return closeExport();
    }
    const blob = new Blob([dialog._files[which]], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    CT.announce(`Exported ${name}`);
    closeExport();
  }

  // The link confirmation (the remote-content rule's link row) --------------------------------------

  function confirmLink(href, from) {
    const u = new URL(href);
    const box = document.createElement("div");
    box.className = "export-dialog lib-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "confirm-title");
    box.innerHTML =
      `<div class="export-card"><h2 id="confirm-title">${esc(u.host)}</h2><p class="confirm-address">${esc(href)}</p><p>Opens in your browser.</p>` +
      `<div class="export-actions"><button type="button" class="button" data-size="sm" data-cf="cancel">Cancel</button><button type="button" class="button" data-size="sm" data-variant="primary" data-cf="open">Open</button></div></div>`;
    $(".app").appendChild(box);
    box._from = from;
    $('[data-cf="cancel"]', box).focus();
  }

  // Opening an item ---------------------------------------------------------------------------------

  function openItem(id, from) {
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const x = item(id) || itemsFor(b).find((y) => y.id === id);
    if (!x) return;
    if (x.kind === "page") return openPage(x.id, from);
    if (x.kind === "link") return confirmLink(x.href, from);
    const A = W.artifacts;
    if (["image", "video"].includes(x.kind) && A[x.id]) return W.openViewer(x.id, from);
    // A file or a recording: its task opens, and Files shows the item.
    if (app.model.selectedTask !== x.task) app.openTask(b.id, x.task);
    app.setPanel(true);
    app.setTab("files");
    if (A[x.id]) W.openArtifact(x.id);
  }

  // The iPhone ------------------------------------------------------------------------------------------

  let holdMenu = null;
  function openHold(id, at) {
    holdMenu?.remove();
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const x = item(id);
    if (!x) return;
    const pinned = isPinned(b.id, id);
    holdMenu = document.createElement("ul");
    holdMenu.className = "menu lib-hold";
    holdMenu.setAttribute("role", "menu");
    holdMenu.setAttribute("aria-label", x.title);
    const entries = [["open", "Open"]];
    if (x.kind === "page") entries.push(["share", "Share as file…"]);
    entries.push(["pin", pinned ? "Unpin" : "Pin"]);
    holdMenu.innerHTML = entries.map(([k, label]) => `<li role="none"><button type="button" class="menu-item" role="menuitem" data-hold="${k}" data-item="${id}">${label}</button></li>`).join("");
    const rowEl = $(`.lib-row[data-item="${id}"]`);
    (rowEl || $("#panel-library")).appendChild(holdMenu);
    holdMenu._at = at;
    $(".menu-item", holdMenu).focus();
  }
  function closeHold() {
    holdMenu?.remove();
    holdMenu = null;
  }

  let sheet = null;
  function openPhonePage(x) {
    sheet?.remove();
    sheet = document.createElement("div");
    sheet.className = "page-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "sheet-title");
    sheet._item = x;
    sheet.innerHTML =
      `<header class="page-sheet-bar"><button type="button" class="icon-button" data-ps="close" aria-label="Close" title="Close">${icon("x")}</button>` +
      `<strong id="sheet-title">${esc(x.title)}</strong><span></span></header>` +
      `<div class="page-sheet-body"><p class="page-sheet-sub">Page · Marlow · ${x.time}</p>` +
      `<p class="page-sheet-lead">Pages are shown on the desktop app for now.</p><p>This version of Clawtrate for iPhone can't draw a page.</p>` +
      (canWrite() ? `<button type="button" class="button" data-variant="primary" data-ps="message">Message about ${esc(x.title)}</button>` : "") +
      `<button type="button" class="button" data-ps="share">Share as file…</button></div>`;
    $(".app").appendChild(sheet);
    $(".shell").inert = true;
    $('[data-ps="close"]', sheet).focus();
  }
  function closePhonePage(andThen) {
    if (!sheet) return;
    const scroll = $("#transcript")?.scrollTop;
    sheet.remove();
    sheet = null;
    $(".shell").inert = false;
    if (scroll !== undefined) $("#transcript").scrollTop = scroll;
    if (andThen) andThen();
    else if (opener && document.contains(opener)) opener.focus();
  }

  // Wiring ---------------------------------------------------------------------------------------------

  // Page cards in the conversation open the Page view (this replaces the media viewer's frame for pages).
  document.addEventListener(
    "click",
    (event) => {
      const card = event.target.closest('[data-viewer="page"], [data-open-page]');
      if (!card) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openPage(card.dataset.openPage || "pj", card);
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const t = event.target;
    if (holdMenu && !t.closest(".lib-hold")) closeHold();
    const hold = t.closest("[data-hold]");
    if (hold) {
      const id = hold.dataset.item;
      const what = hold.dataset.hold;
      closeHold();
      if (what === "open") return openItem(id, $(`[data-lib-open="${id}"]`));
      if (what === "pin") return togglePin(id);
      if (what === "share") return openExport(item(id));
    }
    const ps = t.closest("[data-ps]")?.dataset.ps;
    if (ps === "close") return closePhonePage();
    if (ps === "share") return openExport(sheet._item);
    if (ps === "message") {
      const x = sheet._item;
      return closePhonePage(() => {
        app.model.drafts[x.task] = `About the page “${x.title}”: `;
        app.setPanel(false);
        app.openTask("marlow", x.task);
        const field = $(".composer-input");
        if (field) {
          field.value = app.model.drafts[x.task];
          field.focus();
          field.setSelectionRange(field.value.length, field.value.length);
        }
      });
    }
    const cf = t.closest("[data-cf]");
    if (cf) {
      const box = cf.closest(".lib-confirm");
      if (cf.dataset.cf === "open") CT.toast(`Opens ${$(".confirm-address", box).textContent} in your browser.`);
      box.remove();
      return box._from?.focus();
    }
    const ex = t.closest("[data-ex]")?.dataset.ex;
    if (ex === "cancel") return closeExport();
    if (ex === "save") return saveExport();
    const pv = t.closest("[data-pv]");
    if (pv) {
      const what = pv.dataset.pv;
      if (what === "close") return closePage();
      if (what === "export") return openExport();
      if (what === "pin") return togglePin(view.dataset.item);
      if (what === "links") return openLinks(pv);
      if (what === "open-link") {
        closeMenu();
        CT.toast(`Opens ${pv.dataset.href} in your browser.`);
        return $('[data-pv="links"]')?.focus();
      }
      if (what === "retry") {
        $("#page-stage").innerHTML = `<p class="page-state" aria-busy="true">Loading ${esc($("#page-title").textContent)}…</p>`;
        return setTimeout(() => loadPage(item(view.dataset.item) || { doc: "ebook-apps", title: "E-book apps compared" }), 300);
      }
      if (what === "chat") {
        const hidden = view.classList.toggle("chat-hidden");
        pv.setAttribute("aria-pressed", String(!hidden));
        pv.setAttribute("aria-label", hidden ? "Show the chat" : "Hide the chat");
        if (!hidden) $("#page-chat-input")?.focus();
        return;
      }
      if (what === "send") {
        const field = $("#page-chat-input");
        const text = field.value.trim();
        if (!text) return;
        $("#page-chat-log").insertAdjacentHTML("beforeend", `<div class="msg" data-role="user" data-sent="true"><div class="bubble">${esc(text)}</div></div>`);
        field.value = "";
        return field.focus();
      }
      if (what === "request-access") {
        pv.closest(".access-bar").outerHTML = `<section class="access-bar" role="region" aria-label="Access" data-state="asking"><div class="access-row">${CT.glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span></div></section>`;
        return;
      }
    }
    if (!t.closest("#panel-library")) return;
    const pin = t.closest("[data-lib-pin]");
    if (pin) return togglePin(pin.dataset.libPin);
    const open = t.closest("[data-lib-open]");
    if (open) return openItem(open.dataset.libOpen, open);
    const f = t.closest("[data-lib-filter]");
    if (f) {
      L.filter = f.dataset.libFilter;
      L.shown = {};
      rerender();
      return $(`[data-lib-filter="${L.filter}"]`).focus();
    }
    const more = t.closest("[data-lib-more]");
    if (more) {
      const g = more.dataset.libMore;
      L.shown[g] = (L.shown[g] || 5) + 5;
      return rerender();
    }
    const action = t.closest("[data-lib]")?.dataset.lib;
    if (action === "look") {
      const b = app.bots.find((x) => x.id === app.model.selectedBot);
      L.read += 10;
      const tasks = readTasks(b);
      rerender();
      CT.announce(`Looked in ${tasks.read.length} of ${b.name}'s ${tasks.all.length} tasks`);
      return $("#lib-fresh button")?.focus();
    }
    if (action === "retry" || action === "refresh") {
      L.lib = "loaded";
      return rerender();
    }
    if (action === "request-access") {
      L.access = "asking";
      rerender();
      setTimeout(() => {
        L.access = "requested";
        rerender();
      }, 300);
    }
  });

  // Touch and hold on the phone: half a second, or the context menu.
  let pressTimer = null;
  document.addEventListener("pointerdown", (event) => {
    const r = event.target.closest?.("#panel-library [data-lib-open]");
    if (!r || !phone()) return;
    pressTimer = setTimeout(() => openHold(r.dataset.libOpen), 500);
  });
  document.addEventListener("pointerup", () => clearTimeout(pressTimer));
  document.addEventListener("contextmenu", (event) => {
    const r = event.target.closest?.("#panel-library [data-lib-open]");
    if (!r || !phone()) return;
    event.preventDefault();
    openHold(r.dataset.libOpen);
  });

  document.addEventListener(
    "keydown",
    (event) => {
      const t = event.target;
      if (event.key === "Escape") {
        if (holdMenu) return (event.stopImmediatePropagation(), closeHold());
        const confirm = $(".lib-confirm");
        if (confirm) return (event.stopImmediatePropagation(), confirm.remove(), confirm._from?.focus());
        if (dialog) return (event.stopImmediatePropagation(), event.preventDefault(), closeExport());
        if (menu) return (event.stopImmediatePropagation(), closeMenu(), $('[data-pv="links"]')?.focus());
        if (sheet) return (event.stopImmediatePropagation(), closePhonePage());
        if (view) {
          event.stopImmediatePropagation();
          event.preventDefault();
          if (t.id === "page-chat-input" && t.value.trim()) return t.blur(), $('[data-pv="chat"]').focus();
          return closePage();
        }
      }
      if (view && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
        event.preventDefault();
        return openExport();
      }
      if (view && t.id === "page-chat-input" && (event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        return $('[data-pv="send"]').click();
      }
      // Tab stays inside the Page view, the export dialog or the phone's sheet.
      if (event.key === "Tab" && (view || sheet)) {
        const box = dialog || view || sheet;
        const focusables = $$("button:not([disabled]), textarea, input, iframe, [tabindex]:not([tabindex='-1'])", box).filter((el) => el.offsetParent !== null || el.tagName === "IFRAME");
        if (!focusables.length) return;
        const i = focusables.indexOf(document.activeElement);
        if (event.shiftKey && i <= 0) {
          event.preventDefault();
          focusables.at(-1).focus();
        } else if (!event.shiftKey && i === focusables.length - 1) {
          event.preventDefault();
          focusables[0].focus();
        }
      }
      if (!t.closest?.("#panel-library")) return;
      if (t.dataset.libFilter && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const keys = FILTERS.map((f) => f[0]);
        const i = keys.indexOf(t.dataset.libFilter);
        const n = event.key === "Home" ? 0 : event.key === "End" ? keys.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + keys.length) % keys.length;
        return $(`[data-lib-filter="${keys[n]}"]`).click();
      }
      if (t.dataset.libOpen && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const rows = $$("#panel-library [data-lib-open]");
        const i = rows.indexOf(t);
        const n = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)));
        rows[n].focus();
      }
    },
    true,
  );

  // The prototype bar: what another device or the gateway's owner does.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = $("#proto-extra");
    if (!extra) return;
    setTimeout(() => {
      extra.innerHTML =
        `<span class="run-controls"><button type="button" data-libbar="other">Another device pins</button>` +
        `<button type="button" data-libbar="approve">Owner approves access</button>` +
        `<span id="run-caption">Open Marlow's Work pane, then Library.</span></span>`;
    });
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-libbar]")?.dataset.libbar;
      if (what === "other") {
        const list = pinsOf("marlow");
        if (!list.includes("i8")) list.unshift("i8");
        rerender();
        if (L.filter === "pinned") CT.announce("Pins changed on another device");
      }
      if (what === "approve") {
        app.model.access = "write";
        L.access = null;
        rerender();
        CT.announce("Access granted");
      }
    });
  });

  // The extension: wraps the one work.js set ----------------------------------------------------------

  const base = CT.appExtension || {};
  CT.appExtension = Object.assign({}, base, {
    fixtures(bots, task) {
      base.fixtures?.(bots, task);
      const marlow = bots.find((b) => b.id === "marlow");
      const main = marlow.tasks[0];
      marlow.tasks = MARLOW.map(([id, title, at, when]) =>
        id === "m1" ? main : task(id, title, at, when, id === "m2" ? "I made a page with Saturday's routes." : "Done.", id === "m2" ? { html: trailTranscript() } : {}),
      );
      // Items work-artifacts.js can open: in the viewer, or in Files.
      const A = W.artifacts;
      const art = { i2: pic("#e9efe7", "#58c26f", "Ridge profile"), i3: pic("#dfe7f0", "#5b8dff", "Trail photo"), i8: pic("#f4ece4", "#ff8552", "Newsletter header"), i11: pic("#232428", "#a98bff", "Ridge at dawn"), i10: pic("#16181b", "#3ee6c1", "Ridge walk"), u1: pic("#eceff1", "#9d9fa2", "Map screenshot") };
      for (const x of ITEMS) {
        if (x.kind === "page" || x.kind === "link") continue;
        A[x.id] = {
          task: x.task,
          msg: `msg-${x.task}-${x.seq}`,
          group: ["image", "video"].includes(x.kind) ? `g-${x.task}-${x.seq}` : undefined,
          kind: x.kind,
          name: x.title,
          typeWords: x.type,
          mime: x.kind === "image" ? "image/png" : x.kind === "video" ? "video/mp4" : x.kind === "audio" ? "audio/wav" : "text/markdown",
          size: 1024,
          download: "url",
          time: x.time || "Nov 2",
          icon: "file",
          duration: x.kind === "video" ? "0:48" : x.kind === "audio" ? "0:02" : undefined,
          content: x.kind === "file" ? `# ${x.title}\n\nA file Marlow handed over.\n` : undefined,
          art: art[x.id],
        };
      }
    },
    panel(b, t) {
      base.panel?.(b, t);
      renderLibrary(b, t);
    },
    tabChanged(name) {
      base.tabChanged?.(name);
    },
    connectionChanged(name) {
      base.connectionChanged?.(name);
      if (app) rerender();
    },
    ready(a) {
      app = a;
      base.ready?.(a);
      if (params.get("state") === "readonly") app.model.access = "read";
      rerender();
      if (params.get("lib") === "loading") return;
      const page = params.get("page");
      if (page) {
        const id = page === "trail-guide" ? "p2" : page === "trail-guide-1" ? "p1" : page === "packing-list" ? "p3" : null;
        if (id) setTimeout(() => openPage(id), 50);
      }
      const hold = params.get("hold");
      if (hold) setTimeout(() => openHold(hold), 80);
    },
  });

  // Saturday's trail plan: what Marlow handed over, with the page shown twice.
  function card(id, name, subText, kind, attrs) {
    return (
      `<div class="artifact" data-kind="${kind}" id="card-${id}"><button type="button" class="artifact-main" ${attrs} aria-label="${esc(`${name}, ${subText}. Open`)}">` +
      `<span class="artifact-tile">${icon(kind === "page" ? "page" : "file")}</span><span class="artifact-text"><span class="artifact-name">${esc(name)}</span>` +
      `<span class="artifact-sub">${esc(subText)}</span></span>${kind === "page" ? `<span class="artifact-open">Open</span>` : ""}</button></div>`
    );
  }
  function trailTranscript() {
    return (
      CT.stamp("Today 5:29 PM") +
      W.turn("user", W.bubble("user", "Plan Saturday's hike. Here is the map I have.")) +
      W.turn(
        "assistant",
        W.bubble("assistant", "<p>Here is everything from Saturday.</p>", true) +
          `<div class="artifacts">${card("i1", "trail-report.md", "Markdown · 149 B", "file", 'data-open-artifact="i1"')}</div>`,
      ) +
      W.turn("user", W.bubble("user", "Make me a trail page.")) +
      W.turn("assistant", W.bubble("assistant", "<p>I made a page with Saturday's routes.</p>", true) + `<div class="artifacts">${card("p1", "Trail guide", "Page · Shown again below", "page", 'data-open-page="p1"')}</div>`) +
      W.turn("user", W.bubble("user", "Where do I check the trail conditions?")) +
      W.turn("assistant", W.bubble("assistant", '<p>The park keeps this week\'s trail conditions here: <a href="#" data-link="https://trails.example/conditions">https://trails.example/conditions</a></p>', true)) +
      CT.stamp("Today 5:36 PM") +
      W.turn("user", W.bubble("user", "Add the forest track too.")) +
      W.turn("assistant", W.bubble("assistant", "<p>Done: the page now has the forest track.</p>", true) + `<div class="artifacts">${card("p2", "Trail guide", "Page", "page", 'data-open-page="p2"')}</div>`)
    );
  }
})();
