// The Library and Pages, on local fixtures. docs/design/library.md is the
// specification. This file wraps the extension work.js sets (CT.appExtension):
// it adds Marlow's tasks, fills the Library tab, opens a Page full window with
// its chat, exports a Page, and draws the iPhone's forms at phone width.
// No gateway and no network: the gateway's answers are fixtures, counted so the
// check can see what was read, parsed and drawn, and when.
//
// States from the address (library.md, section 12):
//   ?panel=open&tab=library&bot=marlow&task=m2
//   ?filter=all|pages|media|links|files|pinned
//   ?lib=loading|partial|error|offline|all   ?items=none   ?src=complete
//   ?gate=closed (desktop or web preview before its zero-request check; the iPhone is always closed)
//   ?pins=device|full|none|verify   ?pinfail=conflict|conflict2|noanswer-before|noanswer-after|limit
//   ?page=trail-guide|trail-guide-1|packing-list   ?pageload=failed|large   ?chat=hidden   ?export=open
//   ?exportread=failed   ?exportfail=1   ?sharefail=1
//   ?hold=<item id> (phone)   ?device=desktop (phone width, the desktop app)   ?state=readonly

(function () {
  const CT = window.CT;
  const W = CT.work;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  // Every name, title, address and message the gateway supplies goes through this before it meets markup.
  const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const pinIcon = () =>
    `<svg class="icon" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3z"/><path d="M12 15v5"/></svg>`;
  let app = null;
  const phone = () => document.documentElement.dataset.input === "touch" && params.get("device") !== "desktop";

  // What the check reads: gateway reads of a Page's HTML, parses of it, frames drawn, links handed to the system, files handed over.
  const counters = { reads: 0, parses: 0, mounts: 0 };
  const opened = [];
  const handoffs = [];

  // Fixtures ---------------------------------------------------------------------------------------
  // Today is Thursday, November 19. day: days before today. Monday the 16th starts the week.

  const pic = (a, b, label) => () =>
    `<svg viewBox="0 0 640 400" role="img" aria-label="${esc(label)}"><rect width="640" height="400" fill="${a}"/>` +
    `<path d="M0 320 L160 180 L280 260 L420 120 L640 300 L640 400 L0 400Z" fill="${b}"/></svg>`;

  // Marlow's tasks, newest activity first. at: minutes for the rail's order.
  const MARLOW = [
    ["m2", "Saturday's trail plan", 1057, "5:37 PM"],
    ["m1", "Main", 1018, "4:58 PM"],
    ["m3", "Packing list for the hut", -2, "Tue"],
    ["m4", "Neighborhood newsletter intro", -3, "Mon"],
    ["m5", "Spring reading list", -7, "Nov 12"],
    ["m6", "Ridge photos", -10, "Nov 9"],
    ["m7", "Cover letter opening", -13, "Nov 6"],
    ["m8", "Thank-you note", -15, "Nov 4"],
    ["m9", "Birthday card verse", -20, "Oct 30"],
    ["m10", "Recipe for the potluck", -24, "Oct 26"],
    ["m11", "Old trail notes", -30, "Oct 20"],
    ["m12", "Draft for the club site", -38, "Oct 12"],
  ];
  const taskTitle = (id) => (MARLOW.find((m) => m[0] === id) || [])[1] || app?.bots.flatMap((b) => b.tasks).find((t) => t.id === id)?.title || id;
  const botOf = (task) => app?.bots.find((b) => b.tasks.some((t) => t.id === task)) || app?.bots.find((b) => b.id === "marlow");

  // An address with a user name and password, built at run time: the decision on addresses never lists or opens one.
  const invalidLink = new URL("https://trails.example/private");
  invalidLink.username = "user";
  invalidLink.password = "secret";
  const userinfoAddress = invalidLink.href;

  // Every occurrence. kind page|image|audio|video|file|link. src: which read holds it (artifacts, history, uploads).
  // by: "person" where a history row of the person's establishes it. hist: 2 for a row on the second history page.
  const ITEMS = [
    { id: "i1", task: "m2", kind: "file", title: "trail-report.md", type: "Markdown", size: "149 B", time: "5:31 PM", day: 0, seq: 4, src: "artifacts" },
    { id: "i2", task: "m2", kind: "image", title: "ridge-profile.png", type: "PNG image", size: "1.2 KB", time: "5:31 PM", day: 0, seq: 4, src: "artifacts" },
    { id: "i3", task: "m2", kind: "image", title: "trail-photo.png", type: "PNG image", size: "408 KB", time: "5:31 PM", day: 0, seq: 4, src: "artifacts" },
    { id: "i4", task: "m2", kind: "audio", title: "trail-chime.wav", type: "WAV audio", size: "31 KB", time: "5:31 PM", day: 0, seq: 4, src: "artifacts" },
    { id: "p1", task: "m2", kind: "page", title: "Trail guide", doc: "trail-guide", time: "5:33 PM", day: 0, seq: 8, again: true, src: "history" },
    { id: "k1", task: "m2", kind: "link", title: "https://trails.example/conditions", href: "https://trails.example/conditions", time: "5:34 PM", day: 0, seq: 10, src: "history" },
    { id: "kx1", task: "m2", kind: "link", title: "private notes", href: userinfoAddress, time: "5:34 PM", day: 0, seq: 10, src: "history" },
    { id: "kx2", task: "m2", kind: "link", title: "trails.example/no-scheme", href: "trails.example/no-scheme", time: "5:34 PM", day: 0, seq: 10, src: "history" },
    { id: "i5", task: "m2", kind: "file", title: "trail-report.md", type: "Markdown", size: "149 B", time: "5:36 PM", day: 0, seq: 14, src: "artifacts" },
    { id: "p2", task: "m2", kind: "page", title: "Trail guide", doc: "trail-guide", time: "5:37 PM", day: 0, seq: 18, src: "history" },
    { id: "k5", task: "m2", kind: "link", title: "https://maps.example/trailhead", href: "https://maps.example/trailhead", time: "5:30 PM", day: 0, seq: 2, src: "history", by: "person" },
    { id: "i6", task: "m1", kind: "file", title: "newsletter-intro.md", type: "Markdown", size: "2.1 KB", time: "4:58 PM", day: 0, seq: 6, src: "artifacts" },
    { id: "p3", task: "m3", kind: "page", title: "Packing list", doc: "packing-list", time: "2:10 PM", day: 2, seq: 4, src: "history" },
    { id: "i7", task: "m3", kind: "file", title: "packing.csv", type: "CSV", size: "2 KB", time: "2:10 PM", day: 2, seq: 4, src: "artifacts" },
    { id: "i8", task: "m4", kind: "image", title: "header.png", type: "PNG image", size: "180 KB", time: "11:20 AM", day: 3, seq: 6, src: "artifacts" },
    { id: "k2", task: "m4", kind: "link", title: "Newsletter archive", href: "https://newsletter.example/archive", time: "11:20 AM", day: 3, seq: 6, src: "history" },
    { id: "k7", task: "m4", kind: "link", title: "https://newsletter.example/issues/2026/november/neighborhood-intro-draft-with-photos-and-the-long-list-of-events", href: "https://newsletter.example/issues/2026/november/neighborhood-intro-draft-with-photos-and-the-long-list-of-events", time: "11:21 AM", day: 3, seq: 7, src: "history" },
    { id: "i9", task: "m5", kind: "file", title: "reading-list.md", type: "Markdown", size: "3.4 KB", time: "Nov 12", day: 7, seq: 380, src: "artifacts" },
    { id: "k3", task: "m5", kind: "link", title: "Spring picks", href: "https://books.example/spring", time: "Nov 12", day: 7, seq: 380, src: "history" },
    { id: "i13", task: "m5", kind: "file", title: "first-draft.md", type: "Markdown", size: "5.0 KB", day: null, seq: 12, src: "artifacts" },
    { id: "i10", task: "m6", kind: "video", title: "ridge-walk.mp4", type: "MP4 video", size: "12 MB", time: "Nov 9", day: 10, seq: 3, src: "artifacts" },
    { id: "i11", task: "m6", kind: "image", title: "ridge-dawn.jpg", type: "JPEG image", size: "640 KB", time: "Nov 9", day: 10, seq: 3, src: "artifacts" },
    { id: "p4", task: "m7", kind: "page", title: "Cover letter outline", doc: "cover-outline", time: "Nov 6", day: 13, seq: 9, src: "history", hist: 2 },
    { id: "i14", task: "m8", kind: "file", title: "thank-you.md", type: "Markdown", size: "1 KB", time: "Nov 4", day: 15, seq: 3, src: "artifacts" },
    { id: "k6", task: "m8", kind: "link", title: "Card ideas", href: "https://cards.example/thanks", time: "Nov 4", day: 15, seq: 4, src: "history" },
    { id: "k8", task: "m9", kind: "link", title: "Verse ideas", href: "https://verses.example/birthday", time: "Oct 30", day: 20, seq: 4, src: "history" },
    { id: "i15", task: "m10", kind: "file", title: "potluck.md", type: "Markdown", size: "1 KB", time: "Oct 26", day: 24, seq: 2, src: "artifacts" },
    { id: "i12", task: "m11", kind: "file", title: "old-route.md", type: "Markdown", size: "88 B", time: "Oct 20", day: 30, seq: 5, src: "artifacts" },
    { id: "k4", task: "m12", kind: "link", title: "Club site draft", href: "https://club.example/draft", time: "Oct 12", day: 38, seq: 2, src: "history" },
    { id: "pj", task: "j2", kind: "page", title: "E-book apps compared", doc: "ebook-apps", time: "3:02 PM", day: 0, seq: 2, src: "history" },
    // Occurrences a route can name that the transcript doesn't confirm: a view id no longer in the task, and an app view.
    { id: "ps", task: "m2", kind: "page", title: "Trail guide", doc: "trail-guide", time: "5:20 PM", day: 0, seq: 30, src: "history", stale: true },
    { id: "pm", task: "m2", kind: "page", title: "Route planner", doc: "ebook-apps", time: "5:21 PM", day: 0, seq: 31, src: "history", mcpApp: true },
    // The person's pictures in Saturday's trail plan, from the image listing: four in its first reply, one after its cursor.
    // Metadata only: source "session-transcript-preview", download mode "unsupported", no inline bytes. Nothing to draw or open.
    ...[1, 2, 3, 4, 5].map((n) => ({
      id: `u${n}`,
      task: "m2",
      kind: "image",
      title: `map-${n}.png`,
      type: "PNG image",
      time: "5:29 PM",
      day: 0,
      seq: 1,
      src: "uploads",
      cursor: n === 5 ? 2 : 1,
      by: "person",
      preview: "unavailable",
    })),
  ];
  const item = (id) => ITEMS.find((x) => x.id === id);

  // The pages: their HTML as the gateway sends it, reaching out in every way the frame must stop.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  const PAGES = {
    "trail-guide": {
      html:
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Trail guide</title>` +
        `<script src="https://cdn.example/chart.js"></script><link rel="prefetch" href="https://cdn.example/next.html"><link rel="stylesheet" href="https://cdn.example/site.css">` +
        `<style>body{font:15px/1.5 system-ui,sans-serif;margin:28px 32px;color:#111213;background:#fff}h1{font-size:24px;margin:0 0 4px}` +
        `table{border-collapse:collapse;width:100%;margin-top:14px}th,td{padding:9px 8px;border-bottom:1px solid #e2e2df;text-align:left}` +
        `.chart{height:120px;border:1px dashed #c9c9c5;border-radius:10px;margin-top:14px;display:grid;place-items:center;color:#8a8b8e}` +
        `a{color:#0a6e5c}label{margin-right:14px}</style><style>.chart{background:url(https://cdn.example/bg.png)}</style></head><body>` +
        `<h1>Trail guide</h1><p>Saturday's routes, with what to expect on each. See the <a href="https://trails.example/conditions">park's conditions page</a> before you leave.</p>` +
        `<form action="https://trails.example/track" method="post"><p><label><input type="checkbox" id="dry" name="dry"> Only dry routes</label><label>Sort by <select id="sort" name="sort"><option>Distance</option><option>Climb</option></select></label>` +
        `<input type="text" id="note" name="note" aria-label="Note"><button type="submit" id="go">Save my choice</button></p></form>` +
        `<table><thead><tr><th>Route</th><th>Distance</th><th>Climb</th><th>Ground</th></tr></thead><tbody>` +
        `<tr><td>Lake loop</td><td>6 km</td><td>40 m</td><td>Dry</td></tr><tr><td>Ridge path</td><td>11 km</td><td>520 m</td><td>Muddy below the saddle</td></tr>` +
        `<tr><td>Forest track</td><td>8 km</td><td>180 m</td><td>Dry</td></tr></tbody></table>` +
        `<div class="chart" id="chart">Elevation chart</div><img id="pixel" src="data:image/png;base64,${PNG}" alt="Trail marker"><img id="remote" src="https://cdn.example/map.png" alt="Map of the routes">` +
        `<img id="badtype" src="data:image/svg+xml;base64,PHN2Zy8+" alt="Badge">` +
        `<details><summary>Getting there</summary><p>Park at the north lot; the first bus is at 7:10. <a href="https://maps.example/ridge">Map of the ridge</a>, ` +
        `<a href="http://localhost:8080/admin">the hut's booking page</a>, <a href="${userinfoAddress}">private notes</a>, <a href="/relative">the route file</a>.</p></details>` +
        `<iframe src="https://trails.example/embed"></iframe><meta http-equiv="refresh" content="0;url=https://trails.example/">` +
        `<script>document.getElementById('dry').onchange=()=>{fetch('https://trails.example/track?dry=1')}</script>` +
        `<script>new Chart(document.getElementById('chart'))</script></body></html>`,
    },
    "packing-list": {
      html:
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Packing list</title>` +
        `<style>body{font:15px/1.6 system-ui,sans-serif;margin:28px 32px;color:#111213;background:#fff}h1{font-size:24px;margin:0 0 8px}li{list-style:none}</style></head><body>` +
        `<h1>Packing list for the hut</h1><ul><li><label><input type="checkbox"> Sleeping bag liner</label></li><li><label><input type="checkbox"> Head torch</label></li>` +
        `<li><label><input type="checkbox"> Hut slippers</label></li><li><label><input type="checkbox"> Cash for the warden</label></li></ul>` +
        `<p>The hut's <a href="https://hut.example/rules">house rules</a>.</p></body></html>`,
    },
    "cover-outline": {
      html: `<!doctype html><html><head><title>Cover letter outline</title></head><body><h1>Cover letter outline</h1><ol><li>Why this role</li><li>What I bring</li><li>Close</li></ol></body></html>`,
    },
    "ebook-apps": {
      html:
        `<!doctype html><html><head><title>E-book apps compared</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:28px 32px;color:#111213;background:#fff}td,th{padding:8px;text-align:left;border-bottom:1px solid #e2e2df}</style></head><body>` +
        `<h1>E-book apps compared</h1><table><tr><th>App</th><th>Titles</th><th>Typical wait</th></tr><tr><td>Shelfwise</td><td>48,000</td><td>9 days</td></tr>` +
        `<tr><td>PageLoop</td><td>31,000</td><td>14 days</td></tr><tr><td>Readmore</td><td>22,000</td><td>6 days</td></tr></table>` +
        `<script>sortable(document.querySelector('table'))</script></body></html>`,
    },
  };

  // Addresses (the decision on addresses: one canonical URL, http or https, no user name or password) ---------

  function canonical(raw) {
    try {
      const u = new URL(raw); // a relative or malformed address throws: it stays text
      if (!/^https?:$/.test(u.protocol) || u.username || u.password) return null;
      return u.href;
    } catch {
      return null;
    }
  }
  // The decision's one written-host rule, for every surface that opens an address: the written host only, no lookup.
  // "device" for loopback, "network" for the person's own network and every other special-purpose literal.
  // (In the app this classifier lives in the shared core, beside the link preview's numeric checks.)
  function ipv4Kind(h) {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    if (!m) return undefined;
    const [a, b, c] = m.slice(1).map(Number);
    if (a === 127) return "device";
    const special =
      a === 0 || a === 10 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) || a >= 224;
    return special ? "network" : null;
  }
  function nearby(href) {
    const h = new URL(href).hostname.replace(/\.$/, "").toLowerCase();
    if (/(^|\.)localhost$/.test(h)) return "device";
    const v4 = ipv4Kind(h);
    if (v4 !== undefined) return v4;
    if (h.startsWith("[")) {
      const v6 = h.slice(1, -1);
      // A mapped IPv4 address is checked as IPv4 first: URL writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
      const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v6);
      if (mapped) {
        const hi = parseInt(mapped[1], 16);
        const lo = parseInt(mapped[2], 16);
        return ipv4Kind(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) ?? "network";
      }
      if (v6 === "::1") return "device";
      if (v6 === "::" || /^f[cd]|^fe[89ab]|^ff|^2001:db8:|^64:ff9b:/.test(v6)) return "network";
      return null;
    }
    if (/\.local$/.test(h) || !h.includes(".")) return "network";
    return null;
  }

  /**
   * A Page's HTML for the frame (library.md, section 6). DOMParser is used here for the local Chromium fixture.
   * A production renderer requires a parser that cannot start requests (§6). Then everything that runs,
   * navigates or loads is taken out, forms are unwrapped with their controls
   * kept, and only pictures the address decision allows stay. The policy goes
   * first in its head, and the frame around it is sandbox="".
   */
  const REMOVE = "script, noscript, base, meta[http-equiv], link, iframe, frame, frameset, object, embed, portal, applet, template";
  const DROP = ["href", "xlink:href", "action", "formaction", "target", "ping", "srcdoc", "manifest", "codebase", "archive", "longdesc", "usemap", "integrity"];
  const LOADS = ["src", "srcset", "poster", "data", "background", "lowsrc", "dynsrc"];
  const POLICY = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'";
  const MAX_PICTURE = 2 * 1024 * 1024;
  // A data: picture stays only when its bytes are PNG, JPEG, WebP or GIF, match its label, and decode to 2 MiB at most.
  function allowedPicture(value) {
    const m = /^data:(image\/(png|jpeg|webp|gif));base64,([a-z0-9+/=\s]+)$/i.exec(value || "");
    if (!m) return false;
    let bytes;
    try {
      bytes = atob(m[3].replace(/\s/g, ""));
    } catch {
      return false;
    }
    if (bytes.length > MAX_PICTURE) return false;
    const kind = m[2].toLowerCase();
    const head = (n) => [...bytes.slice(0, n)].map((c) => c.charCodeAt(0));
    if (kind === "png") return head(4).join() === "137,80,78,71";
    if (kind === "jpeg") return head(3).join() === "255,216,255";
    if (kind === "gif") return bytes.startsWith("GIF8");
    return bytes.startsWith("RIFF") && bytes.slice(8, 12) === "WEBP";
  }
  function framedPage(html) {
    counters.parses += 1;
    const doc = new DOMParser().parseFromString(html, "text/html");
    const scripts = doc.querySelectorAll("script").length;
    const links = [...doc.querySelectorAll("a[href], area[href]")].map((a) => canonical(a.getAttribute("href"))).filter(Boolean);
    doc.querySelectorAll(REMOVE).forEach((el) => el.remove());
    // A style's outside references go too; the policy below is the second layer for what this misses.
    // A style block or style attribute stays only if it names nothing outside: no address, import or escape that could hide one.
    const outside = (css) => /url\s*\(|@import|image-set|image\s*\(|cross-fade|element\s*\(|src\s*\(|:\/\/|\\/i.test(css.replace(/\/\*[\s\S]*?\*\//g, ""));
    for (const style of doc.querySelectorAll("style")) if (outside(style.textContent)) style.remove();
    for (const el of doc.querySelectorAll("[style]")) if (outside(el.getAttribute("style"))) el.removeAttribute("style");
    // A link keeps its words, as plain text in the surrounding style.
    for (const a of doc.querySelectorAll("a")) {
      const span = doc.createElement("span");
      span.append(...a.childNodes);
      a.replaceWith(span);
    }
    // A form is unwrapped: its controls stay, and nothing can submit them.
    for (const form of doc.querySelectorAll("form")) form.replaceWith(...form.childNodes);
    for (const el of doc.querySelectorAll("button, input[type=submit], input[type=image]")) el.setAttribute("type", "button");
    for (const el of doc.querySelectorAll("*")) {
      DROP.forEach((name) => el.removeAttribute(name));
      LOADS.forEach((name) => {
        if (!el.hasAttribute(name)) return;
        const keep = name === "src" && el.tagName === "IMG" && allowedPicture(el.getAttribute("src"));
        if (!keep) el.removeAttribute(name);
      });
      for (const attr of [...el.attributes]) if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
    }
    const meta = doc.createElement("meta");
    meta.httpEquiv = "Content-Security-Policy";
    meta.content = POLICY;
    doc.head.prepend(meta);
    return { html: `<!doctype html>${doc.documentElement.outerHTML}`, scripts, links: [...new Set(links)] };
  }
  CT.framedPage = framedPage;

  // Why an occurrence can't be confirmed in its task's transcript, or nothing when it can.
  function unconfirmed(x) {
    if (x.mcpApp) return "This is an app view. It needs scripts, which Clawtrate doesn't run.";
    if (x.stale || !x.doc) return `Clawtrate couldn't confirm this page in ${taskTitle(x.task)}.`;
    return "";
  }

  // The last confirmed copy is bound to the gateway, the task's session and the verified document id.
  const copyKey = (x) => `home-gateway|${x.task}|${sessionOf(x.task)}|${x.doc}`;

  // The gateway's answer to canvas.document.view, counted.
  const LIMIT = 5 * 1024 * 1024; // 5 MiB of UTF-8, for drawing and for export alike
  const bytesOf = (s) => new TextEncoder().encode(s).length;
  function readPage(x, { failed = false, large = false } = {}) {
    counters.reads += 1;
    if (failed) return { error: "Canvas widget unavailable; reload the chat or ask the agent to recreate it." };
    const html = PAGES[x.doc].html;
    if (large || bytesOf(html) > LIMIT) return { large: true };
    L.pageCache[copyKey(x)] = html;
    return { html };
  }

  // State ------------------------------------------------------------------------------------------

  const L = {
    filter: params.get("filter") || "all",
    lib: params.get("lib") || "loaded",
    read: params.get("lib") === "all" ? 99 : 10,
    shown: {},
    pinStore: params.get("pins") === "device" ? "device" : "gateway",
    full: params.get("pins") === "full",
    busy: new Set(),
    pinError: null,
    uncertain: null,
    pinFail: params.get("pinfail"),
    notice: null,
    access: null, // read, asking, requested, denied, expired: the conversation's access request, drawn in the active surface
    accessFor: null,
    cache: new Set(), // items whose content is on the device
    pageCache: {},
    swallow: null,
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const verifying = params.get("pins") === "verify";
  // A pin names its occurrence as section 4 says: the task key, the session the history read reported, the message's
  // identity and sequence, and the artifact's id where the listing reports one (or the block, where history confirms it).
  const sessionOf = (task) => (verifying && task === "m10" ? "s-m10-b" : `s-${task}`); // m10: the key now holds a new session
  const msgOf = (x) => (verifying && x.task === "m9" ? `${x.task}:${x.seq}:b` : `${x.task}:${x.seq}`); // m9: sequence 4 is another message now
  const pinFor = (x) => ({ task: x.task, session: sessionOf(x.task), msg: msgOf(x), seq: x.seq, ...(x.src === "history" ? { block: x.id } : { art: x.id }) });
  const normalize = (v) => (typeof v === "string" ? (item(v) ? pinFor(item(v)) : null) : v); // a bare id stands for its occurrence now
  const gone = { task: "m11", session: "s-m11", msg: "m11:7", seq: 7, art: "a-old-route-2" };
  const startPins =
    params.get("pins") === "none"
      ? []
      : verifying
        ? [
            pinFor(item("p2")),
            gone,
            { task: "m12", session: "s-m12", msg: "m12:2", seq: 2, block: "k4" },
            { task: "m10", session: "s-m10", msg: "m10:2", seq: 2, art: "i15" },
            { task: "m9", session: "s-m9", msg: "m9:4", seq: 4, block: "k8" },
          ]
        : [pinFor(item("p2")), pinFor(item("k3")), gone];
  // The person's preference on the gateway (users.prefs), and what this device last confirmed of it.
  const G = { value: startPins.length ? JSON.parse(JSON.stringify(startPins)) : null };
  const P = { confirmed: startPins.length ? [...startPins] : null, observed: startPins.length ? JSON.parse(JSON.stringify(startPins)) : null };
  const canWrite = () => app && app.model.access === "write";
  const lost = () => L.lib === "offline" || ["offline", "reconnecting"].includes(app?.model.connection);
  const pinsOf = () => (P.confirmed || []).map(normalize).filter(Boolean);
  // What a read establishes about a pin: its occurrence, its absence, or nothing certain.
  function resolvePin(pin) {
    const s = sources(pin.task);
    const x = ITEMS.find((y) => y.task === pin.task && y.seq === pin.seq && y.id === (pin.art || pin.block));
    const src = pin.block ? "history" : "artifacts";
    if (s[src] === "failed") return { state: "unverified", why: `${taskTitle(pin.task)} couldn't be read.` };
    if (pin.session !== sessionOf(pin.task)) return { state: "unverified", why: `${taskTitle(pin.task)} now holds a different session from the one pinned.` };
    const atSeq = ITEMS.find((y) => y.task === pin.task && y.seq === pin.seq);
    if (atSeq && msgOf(atSeq) !== pin.msg) return { state: "unverified", why: `The message at this place in ${taskTitle(pin.task)} is a different one now.` };
    if (x) return { state: "item", x };
    if (src === "history" && incompleteHistory(pin.task)) return { state: "unverified", why: `${taskTitle(pin.task)}'s history wasn't read in full.` };
    return { state: "notfound" }; // a complete read of that exact session found no such occurrence
  }
  const pinKey = (pin) => {
    const r = resolvePin(pin);
    return r.state === "item" ? r.x.id : `pin:${pin.task}:${pin.seq}`;
  };
  const isPinned = (id) => pinsOf().some((pin) => pinKey(pin) === id);
  const gateClosed = () => phone() || params.get("gate") === "closed";

  // What each task's reads returned: artifacts (ok, failed) and history (ok, failed, limit, truncated).
  function sources(task) {
    const s = { artifacts: "ok", history: "ok" };
    if (params.get("src") !== "complete") {
      if (task === "m4") s.history = "truncated";
      if (task === "m5") s.history = "limit";
    }
    if (verifying && task === "m12") s.history = "failed";
    if (L.lib === "partial") {
      if (task === "m6") Object.assign(s, { artifacts: "failed", history: "failed" });
      if (task === "m8") s.artifacts = "failed";
    }
    if (params.get("src") === "history-failed" && task === "m2") s.history = "failed"; // the phone's conversation: its history didn't answer
    if (params.get("src") === "history-only" && ["m3", "m7"].includes(task)) s.history = "limit"; // capped histories, nothing failed
    return s;
  }
  const failedSource = (task) => Object.values(sources(task)).includes("failed");
  const incompleteHistory = (task) => ["limit", "truncated"].includes(sources(task).history);

  function tasksOf(b) {
    return [...b.tasks].sort((x, y) => y.at - x.at).map((t) => t.id);
  }
  function readTasks(b) {
    const all = tasksOf(b);
    return { all, read: all.slice(0, Math.min(L.read, all.length)) };
  }
  // What one task's reads give the bot's Library: the bot's own items, from the sources that answered.
  function listed(x) {
    if (x.by === "person" || x.src === "uploads" || x.stale || x.mcpApp) return false;
    if (x.kind === "link" && !canonical(x.href)) return false; // an address that isn't one stays text in the message
    const s = sources(x.task);
    if (x.src === "artifacts" && s.artifacts === "failed") return false;
    if (x.src === "history" && s.history === "failed") return false;
    return true;
  }
  function itemsFor(b) {
    const ids = new Set(b.tasks.map((t) => t.id));
    const rows = ITEMS.filter((x) => ids.has(x.task) && listed(x));
    if (b.id !== "marlow") {
      // The other bots: what work-artifacts.js hands over in their tasks.
      const A = W.artifacts || {};
      for (const k of Object.keys(A).filter((k) => ids.has(A[k].task) && !item(k)))
        rows.push({ id: k, task: A[k].task, kind: A[k].kind, title: A[k].name, type: A[k].typeWords, size: W.size(A[k].size), time: A[k].time, day: 0, seq: 1, src: "artifacts" });
    }
    return rows;
  }
  // The iPhone's conversation: the bot's items, the person's links where their row was read, and the image listing's entries.
  function conversationItems(t) {
    // The person's links need their history row; the image listing's entries need the item read.
    const answered = (x) => (x.src === "history" ? sources(x.task).history !== "failed" : sources(x.task).artifacts !== "failed");
    return ITEMS.filter((x) => x.task === t.id && (x.kind !== "link" || canonical(x.href)) && (listed(x) || (x.by === "person" && answered(x))));
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
    if (x.src === "uploads") parts.push("Preview unavailable");
    if (x.time) parts.push(x.time);
    if (x.again) parts.push("Shown again below");
    if (x.by === "person") parts.push("sent by you");
    else parts.push(taskTitle(x.task));
    return parts.join(" · ");
  }

  // The Library tab ---------------------------------------------------------------------------------

  function row(x) {
    const pinned = isPinned(x.id);
    const busy = L.busy.has(x.id);
    const unavailable = x.src === "uploads"; // no inline bytes the address decision accepts: nothing to show
    const actions = !unavailable; // an upload's row has no Open, Share or Pin, so no menu
    const what = x.kind === "page" ? "Page" : x.kind === "link" ? `link, ${host(x.href)}` : x.type;
    const spoken = `${x.title}, ${what}, ${x.by === "person" ? "sent by you" : `in ${taskTitle(x.task)}`}${x.time ? `, ${x.time}` : ""}${x.again ? ", shown again below" : ""}${pinned ? ", pinned" : ""}${unavailable ? ". Can't be opened here" : ". Open"}.`;
    const pinLabel = `${pinned ? "Unpin" : "Pin"} ${x.title}`;
    return (
      `<li class="lib-row" data-item="${esc(x.id)}" data-kind="${x.kind}"><button type="button" class="file-row" data-lib-open="${esc(x.id)}" aria-label="${esc(spoken)}" title="${esc(x.title)}"${phone() && actions ? ' aria-haspopup="menu"' : ""}${unavailable ? ' data-unavailable="true"' : ""}>` +
      `<span class="file-icon">${icon(kindIcon(x.kind))}</span><span class="file-name">${esc(x.title)}${pinned ? `<span class="lib-pinmark" aria-hidden="true">${pinIcon()}</span>` : ""}</span>` +
      `<span class="file-sub">${esc(sub(x))}</span></button>` +
      (x.src === "uploads"
        ? ""
        : `<button type="button" class="icon-button lib-pin" data-variant="quiet" data-lib-pin="${esc(x.id)}" aria-pressed="${pinned}" aria-label="${esc(pinLabel)}" title="${pinned ? "Unpin" : "Pin"}"${busy ? ' aria-busy="true" disabled' : ""}>${pinIcon()}</button>`) +
      `</li>`
    );
  }

  // A task counts as read in full only when both its reads completed: a failed source, a capped history or a
  // truncated row leaves it out, and the rows its answering sources gave stay listed.
  function coverage(b, tasks, conv) {
    const failed = tasks.read.filter(failedSource);
    const incomplete = tasks.read.filter(incompleteHistory);
    return { failed, incomplete, confirmed: tasks.read.filter((id) => !failedSource(id) && !incompleteHistory(id)).length };
  }

  function freshness(b, tasks, conv, cov) {
    const name = esc(b.name);
    if (L.lib === "loading") return `<div class="files-fresh" role="status"><span>Looking in ${name}'s tasks…</span></div>`;
    let words;
    if (lost()) words = "Can't reach the gateway · showing what was read at 5:41 PM";
    else if (conv) words = "In this conversation · checked 5:41 PM";
    else if (cov.confirmed === tasks.all.length) words = `Read all ${tasks.all.length} of ${name}'s tasks in full · checked 5:41 PM`;
    else words = `Read ${cov.confirmed} of ${name}'s ${tasks.all.length} tasks in full · checked 5:41 PM`;
    return (
      `<div class="files-fresh" role="status" id="lib-fresh"><span>${words}</span>` +
      (lost() ? "" : `<button type="button" class="icon-button" data-variant="quiet" data-lib="refresh" aria-label="Refresh the library" title="Refresh">${icon("retry")}</button>`) +
      `</div>`
    );
  }

  // The conversation's access request, wherever the person asked for it (conversation.md, section 3).
  function accessSection(where) {
    const s = L.access;
    if (!s) return "";
    const why = L.accessFor === "chat" ? "Messaging" : "Pinning";
    const again = `<button type="button" class="button" data-size="sm" data-access="request">Request again</button>`;
    const text = {
      read: `${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${why} needs permission to change things on the gateway.</span><button type="button" class="button" data-size="sm" data-variant="primary" data-access="request">Request access</button>`,
      asking: `${CT.glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`,
      requested: `${CT.glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine: <code>openclaw devices approve 7c41d09e</code>. This changes by itself when the owner approves or denies it, or it expires.</span>`,
      denied: `${CT.glyph("stopped")}<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device can still read.</span>${again}`,
      expired: `${CT.glyph("stopped")}<span class="shelf-text"><b>The request expired</b> before it was approved.</span>${again}`,
    }[s];
    return `<section class="access-bar lib-access" role="region" aria-label="Access" data-state="${s}" data-where="${where}" tabindex="-1"><div class="access-row">${text}</div></section>`;
  }
  function renderAccess() {
    const where = sheet ? "sheet" : view ? "page" : "library";
    $$(".lib-access").forEach((el) => el.remove());
    const html = accessSection(where);
    if (!html) return;
    if (where === "sheet") $(".page-sheet-body", sheet).insertAdjacentHTML("beforeend", html);
    else if (where === "page") $("#page-access", view).innerHTML = html;
    else rerender();
    focusAccess();
  }
  const focusAccess = () => ($(".lib-access [data-access]") || $(".lib-access"))?.focus();

  function notes(b, tasks, conv, cov) {
    let html = "";
    if (cov.failed.length)
      html += conv
        ? `<p class="lib-failed" role="alert">${icon("warning")}<span>Couldn't fully read this conversation.</span>${lost() ? "" : `<button type="button" class="button" data-size="sm" data-lib="retry">Try Again</button>`}</p>`
        : `<p class="lib-failed" role="alert">${icon("warning")}<span>Couldn't fully read ${cov.failed.length} task${cov.failed.length === 1 ? "" : "s"}.</span>${lost() ? "" : `<button type="button" class="button" data-size="sm" data-lib="retry">Try again</button>`}</p>`;
    if (cov.incomplete.length) html += `<p class="lib-group-note" id="lib-incomplete">Older messages or some message content weren't read${conv ? "" : ` in ${cov.incomplete.length} task${cov.incomplete.length === 1 ? "" : "s"}`}.</p>`;
    if (conv) html += `<p class="lib-group-note" id="lib-uploads">Some uploads may be missing.</p>`;
    if (L.uncertain) html += `<p class="lib-failed" role="status">${icon("warning")}<span>${esc(L.uncertain)}</span></p>`;
    if (L.pinError) html += `<p class="lib-failed" role="alert">${icon("warning")}<span>${esc(L.pinError)}</span></p>`;
    if (L.notice) html += `<p class="lib-failed" role="alert">${icon("warning")}<span>${esc(L.notice)}</span></p>`;
    return html;
  }

  function renderLibrary(b, t) {
    const panel = $("#panel-library");
    if (!panel) return;
    const keep = document.activeElement && panel.contains(document.activeElement) ? keyOf(document.activeElement) : null;
    const conv = phone() && t; // the iPhone: this conversation's library
    const tasks = conv ? { all: [t.id], read: [t.id] } : readTasks(b);
    const cov = coverage(b, tasks, conv);
    let items = conv ? conversationItems(t) : itemsFor(b).filter((x) => tasks.read.includes(x.task));
    if (params.get("items") === "none") items = [];
    const filters =
      `<div class="lib-filters" role="radiogroup" aria-label="Show">` +
      FILTERS.map(([k, label]) => `<button type="button" class="lib-filter" role="radio" aria-checked="${L.filter === k}" tabindex="${L.filter === k ? 0 : -1}" data-lib-filter="${k}">${label}</button>`).join("") +
      `</div>`;
    let body = "";
    let top = "";
    if (L.lib === "loading") {
      body = `<div class="files" aria-busy="true" aria-label="Loading the library">${'<div class="skeleton-row"></div>'.repeat(5)}</div>`;
    } else if (L.lib === "error") {
      body =
        `<div class="work-empty" role="alert"><span class="empty-mark">${CT.glyph("failed")}</span><h4>Couldn't load ${conv ? "this conversation's" : `${esc(b.name)}'s`} library</h4>` +
        `<p>The gateway did not answer.</p><button type="button" class="button" data-size="sm" data-lib="retry">${conv ? "Try Again" : "Try again"}</button></div>`;
    } else {
      top = notes(b, tasks, conv, cov);
      if (L.filter === "pinned") body = pinnedList(b, conv ? t : null);
      else {
        const shown = items.filter((x) => matches(x, L.filter));
        if (!shown.length) body = empty(b, conv, cov);
        else
          body = GROUPS.map(([g, word]) => {
            const rows = shown.filter((x) => groupOf(x) === g).sort((a, c) => (a.day ?? 99) - (c.day ?? 99) || minutes(c) - minutes(a) || c.seq - a.seq);
            if (!rows.length) return "";
            const n = L.shown[g] || 5;
            const more = rows.length - n;
            return (
              `<section class="lib-group" data-group="${g}"><h3 id="lib-h-${g}">${word}</h3>` +
              (g === "unread" ? `<p class="lib-group-note">The message time wasn't available in the history read.</p>` : "") +
              `<ul class="file-list" aria-labelledby="lib-h-${g}">${rows.slice(0, n).map(row).join("")}</ul>` +
              (more > 0 ? `<button type="button" class="lib-more" data-lib-more="${g}">Show ${Math.min(5, more)} more</button>` : "") +
              `</section>`
            );
          }).join("");
      }
    }
    const foot =
      !conv && !lost() && !["loading", "error"].includes(L.lib) && tasks.read.length < tasks.all.length && L.filter !== "pinned"
        ? `<button type="button" class="button lib-look" data-size="sm" data-lib="look">Look in ${Math.min(10, tasks.all.length - tasks.read.length)} more tasks</button>`
        : "";
    const access = !view && !sheet ? accessSection("library") : "";
    panel.innerHTML = `<div class="library" data-scope="${conv ? "conversation" : "bot"}">${filters}${freshness(b, tasks, conv, cov)}${top}${body}${foot}${access}</div>`;
    if (keep) restore(keep);
  }

  function empty(b, conv, cov) {
    const what = { all: null, pages: "pages", media: "pictures, recordings or videos", links: "links", files: "files" }[L.filter];
    const partial = cov.failed.length || cov.incomplete.length;
    if (!what)
      return `<div class="work-empty"><span class="empty-mark">${icon("tasks")}</span><h4>Nothing found</h4><p>Pages, pictures, files and links ${esc(b.name)} sends appear here.</p></div>`;
    const mark = `<span class="empty-mark">${icon(kindIcon({ pages: "page", media: "image", links: "link", files: "file" }[L.filter]))}</span>`;
    // On iPhone the person's uploads may be missing, so media found there is only ever what the item reads gave.
    if (conv && L.filter === "media") return `<div class="work-empty">${mark}<h4>No media in the items read.</h4></div>`;
    const where = partial ? "in the messages read" : conv ? "in this conversation" : "in the tasks searched";
    return `<div class="work-empty">${mark}<h4>No ${what} ${where}.</h4></div>`;
  }

  // Each pin resolved by the ordinary reads: a row only where the same-session source confirms the occurrence.
  function pinnedList(b, convTask) {
    let ids = pinsOf();
    if (convTask) ids = ids.filter((pin) => pin.task === convTask.id); // the conversation's own pins only
    const where = L.pinStore === "device" ? `<p class="lib-group-note" id="lib-pin-where">Kept on this device only: the gateway keeps no preferences for this connection.</p>` : "";
    if (!ids.length)
      return (
        `<div class="work-empty"><span class="empty-mark">${pinIcon()}</span><h4>Nothing pinned</h4>` +
        `<p>Pin an item to keep it here. Pins are kept ${L.pinStore === "device" ? "on this device" : "on the gateway, for every connection on your profile"}.</p></div>`
      );
    const quiet = (id, name, line, spoken) =>
      `<li class="lib-row" data-item="${esc(id)}" data-unresolved="true"><div class="file-row" role="group" aria-label="${esc(spoken)}"><span class="file-icon">${icon("file")}</span>` +
      `<span class="file-name">${esc(name)}</span><span class="file-sub">${esc(line)}</span></div>` +
      `<button type="button" class="button lib-unpin" data-size="sm" data-lib-pin="${esc(id)}">Unpin</button></li>`;
    const rows = ids
      .map((pin) => {
        const r = resolvePin(pin);
        const key = pinKey(pin);
        if (r.state === "item") return row(r.x);
        if (r.state === "notfound") return quiet(key, `Not found in ${taskTitle(pin.task)}`, "A complete read of this task found no such message.", `A pinned item not found in ${taskTitle(pin.task)}`);
        return quiet(key, "Couldn't verify this pinned item", r.why, "A pinned item that couldn't be verified");
      })
      .join("");
    return `<section class="lib-group" data-group="pinned"><h3 id="lib-h-pinned">Pinned</h3>${where}<ul class="file-list" aria-labelledby="lib-h-pinned">${rows}</ul></section>`;
  }

  // Keep focus on the same control across a re-render.
  const keyOf = (el) =>
    el.dataset.libOpen
      ? `[data-lib-open="${el.dataset.libOpen}"]`
      : el.dataset.libPin
        ? `[data-lib-pin="${el.dataset.libPin}"]`
        : el.dataset.libFilter
          ? `[data-lib-filter="${el.dataset.libFilter}"]`
          : el.dataset.lib
            ? `[data-lib="${el.dataset.lib}"]`
            : el.dataset.access
              ? `[data-access="${el.dataset.access}"]`
              : null;
  const restore = (key) => $(key)?.focus();

  const rerender = () => {
    if (!app) return;
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const t = b.tasks.find((x) => x.id === app.model.selectedTask) || null;
    renderLibrary(b, t);
  };

  // Pins ---------------------------------------------------------------------------------------------
  // Every change is a compare-and-set against the value last observed; nothing is shown until a read holds it.

  let otherDevice = 0;
  function anotherDeviceWrites() {
    const id = ["i8", "i11", "i3"][otherDevice % 3];
    otherDevice += 1;
    G.value = [pinFor(item(id)), ...(G.value || []).map(normalize).filter((p) => p && pinKey(p) !== id)];
  }
  function gatewaySet(next, expected) {
    if (!same(expected, G.value)) return "conflict";
    G.value = next && next.length ? next : null; // removing the last pin deletes the key
    return "ok";
  }
  function readBack() {
    P.observed = G.value ? JSON.parse(JSON.stringify(G.value)) : null;
    P.confirmed = P.observed ? P.observed.map(normalize).filter(Boolean) : null;
  }
  const changeOf = (list, id, pin) => {
    const now = (list || []).map(normalize).filter((p) => p && pinKey(p) !== id);
    return pin ? [pinFor(item(id)), ...now] : now;
  };

  function togglePin(id, from) {
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const x = item(id) || itemsFor(b).find((y) => y.id === id);
    const name = x ? x.title : "this item";
    const pin = !isPinned(id);
    L.pinError = null;
    L.notice = null;
    if (!canWrite() && L.pinStore === "gateway") {
      L.access = "read";
      L.accessFor = "pin";
      L.accessItem = id;
      return renderAccess();
    }
    if (pin && L.full) {
      L.pinError = `${b.name}'s pins are full. Unpin one to pin this.`;
      CT.announce(`Couldn't pin ${name}`);
      return redraw();
    }
    if (L.pinStore === "device") {
      P.confirmed = changeOf(P.confirmed, id, pin);
      CT.announce(`${pin ? "Pinned" : "Unpinned"} ${name}`);
      return redraw();
    }
    L.busy.add(id);
    redraw();
    setTimeout(() => {
      L.busy.delete(id);
      const fail = L.pinFail;
      const verb = pin ? "pin" : "unpin";
      if (fail === "limit") {
        L.pinError = "Couldn't pin: the gateway keeps at most 128 of your settings, and they are used.";
        CT.announce(`Couldn't ${verb} ${name}`);
        return redraw();
      }
      if (fail === "noanswer-before" || fail === "noanswer-after") {
        if (fail === "noanswer-after") gatewaySet(changeOf(P.observed, id, pin), P.observed); // it reached the gateway; the answer didn't come back
        L.uncertain = "Couldn't confirm this pin change. Checking when the gateway is back.";
        L.pending = { id, pin, name };
        app.setConnection("reconnecting");
        return redraw();
      }
      if (fail === "conflict" || fail === "conflict2") anotherDeviceWrites();
      let answer = gatewaySet(changeOf(P.observed, id, pin), P.observed);
      if (answer === "conflict") {
        readBack(); // read the key, then apply the one change once, if it is still needed
        if (isPinned(id) !== pin) {
          if (fail === "conflict2") anotherDeviceWrites();
          answer = gatewaySet(changeOf(P.observed, id, pin), P.observed);
        } else answer = "ok";
      }
      readBack();
      if (answer === "conflict" || isPinned(id) !== pin) {
        L.pinError = `Couldn't ${verb}: ${b.name}'s pins kept changing on the gateway. Try again.`;
        CT.announce(`Couldn't ${verb} ${name}`);
      } else CT.announce(`${pin ? "Pinned" : "Unpinned"} ${name}`);
      redraw();
      from?.isConnected && from.focus();
    }, 350);
  }
  // users.prefs.changed carries only the profile and the keys, and reaches this device too: read, and say so only if it differs.
  function prefsChanged() {
    const before = P.confirmed;
    readBack();
    if (!same(before, P.confirmed) && L.filter === "pinned") CT.announce("Pins changed");
    redraw();
  }
  function reconnected() {
    if (!L.pending) return;
    const { id, pin, name } = L.pending;
    L.pending = null;
    L.uncertain = null;
    if (params.get("pinread") === "fail") {
      // The read on reconnect didn't answer either: the last confirmed mark stays, and so does the doubt.
      L.uncertain = "Couldn't confirm this pin change. Checking when the gateway is back.";
      L.pending = { id, pin, name };
      return redraw();
    }
    readBack(); // read, never resend
    if (isPinned(id) === pin) CT.announce(`${pin ? "Pinned" : "Unpinned"} ${name}`);
    else L.pinError = pin ? "This item isn't pinned on the gateway. Try again." : "This item is still pinned on the gateway. Try again.";
    redraw();
  }
  function redraw() {
    rerender();
    syncPageBar();
  }

  // The Page view --------------------------------------------------------------------------------------

  let view = null;
  let opener = null;
  let openerScroll = null;
  let loadFails = params.get("pageload") === "failed";
  const narrow = () => innerWidth < 1000 || document.documentElement.dataset.width === "800" || document.documentElement.dataset.width === "phone";

  // Every way to a Page arrives here: a conversation card, a Library row, the media viewer's former page route.
  function openPage(id, from) {
    const x = item(id);
    if (!x || x.kind !== "page") return;
    opener = from || document.activeElement;
    openerScroll = $("#transcript")?.scrollTop ?? null;
    const b = botOf(x.task);
    // The occurrence's task is the active one before anything is read for it.
    if (app.model.selectedTask !== x.task) {
      app.openTask(b.id, x.task);
      openerScroll = null;
    }
    if (phone()) return openPhonePage(x);
    view?.remove();
    view = document.createElement("div");
    view.className = "page-view";
    view.setAttribute("role", "dialog");
    view.setAttribute("aria-modal", "true");
    view.setAttribute("aria-labelledby", "page-title");
    view.dataset.item = x.id;
    view.dataset.bot = b.id;
    view.dataset.state = "loading";
    view._x = x;
    if (params.get("chat") === "hidden" || narrow()) view.classList.add("chat-hidden");
    const pinned = isPinned(x.id);
    view.innerHTML =
      `<header class="page-bar"><button type="button" class="icon-button" data-pv="close" aria-label="Close the page" title="Close (Esc)">${icon("x")}</button>` +
      `<div class="page-title"><strong id="page-title">${esc(x.title)}</strong><span>Page · ${esc(b.name)} · ${esc(taskTitle(x.task))} · ${esc(x.time)}</span></div>` +
      `<button type="button" class="button" data-size="sm" data-pv="export" disabled>Export…</button>` +
      `<button type="button" class="icon-button" data-variant="quiet" data-pv="pin" aria-pressed="${pinned}" aria-label="${pinned ? "Unpin" : "Pin"} ${esc(x.title)}" title="${pinned ? "Unpin" : "Pin"}">${pinIcon()}</button>` +
      `<button type="button" class="icon-button" data-variant="quiet" data-pv="chat" aria-pressed="${!view.classList.contains("chat-hidden")}" aria-label="${view.classList.contains("chat-hidden") ? "Show the chat" : "Hide the chat"}" title="Chat">${icon("message")}</button></header>` +
      `<div class="page-note" id="page-note" hidden></div><div id="page-access"></div>` +
      `<div class="page-body"><div class="page-stage" id="page-stage" aria-busy="true"><p class="page-state">Loading ${esc(x.title)}…</p></div>` +
      `<aside class="page-chat" aria-label="Chat about ${esc(x.title)}">${chat(x, b)}</aside></div>`;
    $(".app").appendChild(view);
    $(".shell").inert = true;
    $('[data-pv="close"]', view).focus();
    if (L.access) renderAccess();
    setTimeout(loadPage, 300, view);
    if (!view.classList.contains("chat-hidden")) setTimeout(() => view?._x === x && offerPrefix(x, null, false), 320);
  }

  function setState(state, html) {
    const stage = $("#page-stage");
    stage.removeAttribute("aria-busy");
    view.dataset.state = state;
    stage.innerHTML = html;
    const ex = $('[data-pv="export"]', view);
    const exportable = state === "shown" || state === "unavailable";
    ex.disabled = !exportable;
    if (exportable) ex.removeAttribute("title");
    else ex.title = "Nothing to export: the page didn't load";
  }

  function loadPage(requestedView) {
    if (view !== requestedView) return;
    const x = requestedView._x;
    const name = esc(botOf(x.task).name);
    // The occurrence first, for drawing and export alike: a view id on a canvas block in this task's transcript, not an app view.
    const why = unconfirmed(x);
    if (why) return setState("unconfirmed", `<div class="page-state" role="status"><p><strong>${esc(why)}</strong></p></div>`);
    // Before this platform's zero-request check passes, nothing is read, parsed or drawn; Export reads when chosen.
    if (gateClosed())
      return setState("unavailable", `<div class="page-state" role="status"><p><strong>Clawtrate can't show pages here yet.</strong></p><p>You can export this page as a file${canWrite() ? `, or ask ${name} about it in the chat` : ""}.</p></div>`);
    // Connected, each opening reads the entrypoint again; offline, only the last confirmed copy for this occurrence.
    let html = lost() ? L.pageCache[copyKey(x)] : undefined;
    const fromCopy = Boolean(html);
    if (!html) {
      if (lost()) return setState("offline", `<div class="page-state" role="alert"><p><strong>Couldn't reach the gateway. Try again when it's back.</strong></p></div>`);
      const got = readPage(x, { failed: loadFails, large: params.get("pageload") === "large" });
      if (got.error) {
        loadFails = false;
        return setState(
          "failed",
          `<div class="page-state" role="alert"><p><strong>The gateway couldn't show this page.</strong></p><p>The gateway said: ${esc(got.error)}</p>` +
            `<button type="button" class="button" data-size="sm" data-pv="retry">Try again</button></div>`,
        );
      }
      if (got.large) return setState("large", `<div class="page-state" role="alert"><p><strong>${esc(x.title)} is larger than Clawtrate shows (5 MiB).</strong></p></div>`);
      html = got.html;
    }
    L.cache.add(x.id);
    const framed = framedPage(html);
    view._framed = framed;
    view._raw = html;
    setState("shown", "");
    // The frame has its sandbox and its document before it joins the page.
    const frame = document.createElement("iframe");
    frame.className = "page-frame";
    frame.setAttribute("sandbox", "");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", `${x.title}, page. Shift+Tab leaves it.`);
    frame.srcdoc = framed.html;
    $("#page-stage").appendChild(frame);
    counters.mounts += 1;
    const note = $("#page-note");
    const parts = [];
    if (framed.scripts) parts.push(`Shown without its ${framed.scripts} script${framed.scripts === 1 ? "" : "s"}. Parts that need them don't work here.`);
    if (framed.links.length) parts.push("Links aren't followed here.");
    parts.push("Checkboxes, menus and folded sections change only this view.");
    if (fromCopy) parts.unshift("Offline · showing the copy last read in this session.");
    note.innerHTML =
      `<span id="page-note-text">${parts.join(" ")}</span>` +
      (framed.links.length ? `<button type="button" class="link-button" data-pv="links" aria-haspopup="menu" aria-expanded="false">Links (${framed.links.length})</button>` : "");
    note.hidden = false;
    view.setAttribute("aria-describedby", "page-note-text");
    if (params.get("export") === "open") openExport();
  }

  function chat(x, b) {
    const head =
      `<div class="page-chat-head">${CT.avatar ? CT.avatar(b.id) : ""}<strong>${esc(taskTitle(x.task))}</strong>` +
      `<button type="button" class="icon-button page-chat-close" data-variant="quiet" data-pv="chat-close" aria-label="Close the chat" title="Close the chat">${icon("x")}</button></div>`;
    const list = `<div class="page-chat-log" id="page-chat-log">${sideLog()}</div>`;
    return head + list + `<div class="page-chat-foot">${chatFoot(x, b)}</div>`;
  }
  // The side chat draws the occurrence task's own transcript and outbox, as the conversation renders them (the Page
  // view made that task the open one). Only message and queue state is copied: no card, link, control or id.
  function sideLog() {
    const inner = $("#transcript .transcript-inner") || $("#transcript");
    if (!inner) return "";
    return [...inner.children]
      .filter((el) => el.matches(".turn, .event-line"))
      .slice(-14)
      .map((el) => {
        const c = el.cloneNode(true);
        c.querySelectorAll(".artifacts, button, input, textarea, select, [tabindex]").forEach((e) => e.replaceWith());
        c.querySelectorAll("a").forEach((a) => a.replaceWith(document.createTextNode(a.textContent)));
        [c, ...c.querySelectorAll("[id], [data-testid]")].forEach((e) => {
          e.removeAttribute("id");
          e.removeAttribute("data-testid");
        });
        return c.outerHTML;
      })
      .join("");
  }
  function refreshSideLog() {
    const log = view && $("#page-chat-log", view);
    if (!log) return;
    log.innerHTML = sideLog();
    log.scrollTop = log.scrollHeight;
  }
  function chatFoot(x, b) {
    if (!canWrite())
      return (
        `<div class="page-chat-readonly">${icon("eye")}<span>Read-only: messages can't be sent from this device.</span>` +
        `<button type="button" class="button" data-size="sm" data-variant="primary" data-pv="request-access">Request access</button></div>`
      );
    // The task's own draft, shared with its conversation's composer.
    const draft = app.model.drafts[x.task] || "";
    return (
      `<div class="page-chat-composer"><textarea id="page-chat-input" rows="2" aria-label="Message ${esc(b.name)} in ${esc(taskTitle(x.task))}">${esc(draft)}</textarea>` +
      `<button type="button" class="icon-button send-button" data-pv="send" aria-label="Send">${icon("arrow-up")}</button></div>`
    );
  }
  function refreshChat() {
    if (!view) return;
    const x = view._x;
    $(".page-chat-foot", view).innerHTML = chatFoot(x, botOf(x.task));
  }

  // The words about the page go into the task's draft: at once when it is empty, after "Replace your draft?" when it isn't.
  function offerPrefix(x, done, focus = true) {
    if (!canWrite()) return done?.();
    const prefix = `About the page “${x.title}”: `;
    const draft = app.model.drafts[x.task] || "";
    const fill = () => {
      app.model.drafts[x.task] = prefix;
      if (done) return done();
      refreshChat();
      if (focus) focusDraft();
    };
    if (draft === prefix) return done ? done() : refreshChat();
    if (!draft.length) return fill();
    confirmDraft(botOf(x.task).name, fill, () => (done ? done() : focusDraft()));
  }
  function focusDraft() {
    const field = $("#page-chat-input");
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }
  let draftBox = null;
  function confirmDraft(botName, replace, keep) {
    draftBox?.remove();
    draftBox = document.createElement("div");
    draftBox.className = "export-dialog lib-draft";
    draftBox.setAttribute("role", "alertdialog");
    draftBox.setAttribute("aria-modal", "true");
    draftBox.setAttribute("aria-labelledby", "draft-title");
    draftBox.setAttribute("aria-describedby", "draft-text");
    draftBox.innerHTML =
      `<div class="export-card"><h2 id="draft-title">Replace your draft?</h2><p id="draft-text">You already have a draft in this chat with ${esc(botName)}. Replacing it discards that draft.</p>` +
      `<div class="export-actions"><button type="button" class="button" data-size="sm" data-dr="keep">Keep draft</button><button type="button" class="button" data-size="sm" data-variant="primary" data-dr="replace">Replace draft</button></div></div>`;
    draftBox._keep = keep;
    draftBox._replace = replace;
    $(".app").appendChild(draftBox);
    $('[data-dr="keep"]', draftBox).focus();
  }
  function closeDraft(choice) {
    const box = draftBox;
    if (!box) return;
    box.remove();
    draftBox = null;
    (choice === "replace" ? box._replace : box._keep)();
  }

  function syncPageBar() {
    if (!view) return;
    const pinned = isPinned(view.dataset.item);
    const b = $('[data-pv="pin"]', view);
    const title = $("#page-title").textContent;
    b.setAttribute("aria-pressed", String(pinned));
    b.setAttribute("aria-label", `${pinned ? "Unpin" : "Pin"} ${title}`);
  }

  function closePage() {
    if (!view) return;
    closeMenu();
    closeExport(false);
    view.remove();
    view = null;
    $(".shell").inert = false;
    if (L.access) rerender();
    if (openerScroll !== null && $("#transcript")) $("#transcript").scrollTop = openerScroll;
    const back = opener && opener.isConnected ? opener : opener?.dataset?.libOpen ? $(`[data-lib-open="${opener.dataset.libOpen}"]`) : null;
    back?.focus();
  }

  // Menus: the Page's links, and the phone's touch-and-hold menu --------------------------------------

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
    menu._opener = button;
    // Each item's text is the whole canonical address, wrapped, never cut.
    menu.innerHTML = view._framed.links.map((h) => `<li role="none"><button type="button" class="menu-item" role="menuitem" data-pv="open-link" data-href="${esc(h)}">${esc(h)}</button></li>`).join("");
    button.after(menu);
    button.setAttribute("aria-expanded", "true");
    $(".menu-item", menu).focus();
  }

  // Export ---------------------------------------------------------------------------------------------

  let dialog = null;
  // One name: the title's last part, with nothing a file system reads as a path, then .html.
  function fileName(title) {
    const base = String(title)
      .split(/[\\/]/)
      .pop()
      .replace(/[\u0000-\u001f<>:"|?*]/g, "-")
      .replace(/^[\s.]+|[\s.]+$/g, "")
      .slice(0, 120);
    return `${base || "Page"}.html`;
  }
  // The desktop button and ⌘E share the Page view's state; the phone's sheet and its row menu name their own occurrence.
  function exportReady(x, from) {
    if (!x || x.kind !== "page" || unconfirmed(x)) return false;
    if (view) return view._x === x && ["shown", "unavailable"].includes(view.dataset.state);
    if (sheet) return sheet._x === x;
    return phone() && x.task === app.model.selectedTask && from?.dataset?.libOpen === x.id;
  }

  function openExport(x = view?._x, from = document.activeElement) {
    if (!exportReady(x, from)) return;
    const drawn = Boolean(view && view._raw && view.dataset.state === "shown");
    const b = botOf(x.task);
    dialog?.remove();
    dialog = document.createElement("div");
    dialog.className = "export-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "export-title");
    dialog._x = x;
    dialog._opener = from;
    dialog._phone = phone();
    dialog._name = fileName(x.title);
    dialog._drawn = drawn;
    dialog.innerHTML =
      `<div class="export-card"><h2 id="export-title">${phone() ? "Share" : "Export"} ${esc(x.title)}</h2><div class="export-body" id="export-body"></div>` +
      `<p class="export-error" role="alert" hidden></p>` +
      `<div class="export-actions"><button type="button" class="button" data-size="sm" data-ex="cancel">Cancel</button>` +
      `<button type="button" class="button" data-size="sm" data-variant="primary" data-ex="save" disabled>${phone() ? "Share…" : "Save…"}</button></div></div>`;
    (view || sheet || $(".app")).appendChild(dialog);
    if (!view && !sheet) {
      $(".shell").inert = true; // over the Library: the shell waits until the dialog closes
      dialog._overShell = true;
    }
    if (drawn) return choices(view._raw, view._framed, b);
    // Not drawn here: the entrypoint is read over the socket now that the person asked for the file.
    readForExport(x, b);
  }
  // Each read belongs to the dialog that started it: a reply for a closed or later dialog is dropped.
  function readForExport(x, b) {
    const current = dialog;
    const read = (current._read = Symbol("read"));
    const live = () => dialog === current && current._x === x && current._read === read;
    current._files = null;
    $('[data-ex="save"]', current).disabled = true;
    $("#export-body", current).innerHTML = `<p class="export-one" aria-busy="true">Reading ${esc(x.title)} from the gateway…</p>`;
    $('[data-ex="cancel"]', current).focus();
    setTimeout(() => {
      if (!live()) return;
      if (lost()) return exportProblem("Couldn't reach the gateway. Try again when it's back.");
      const got = readPage(x, { failed: params.get("exportread") === "failed" });
      if (!live()) return;
      if (got.error) return exportProblem(`Couldn't read ${x.title} from the gateway. The gateway said: ${got.error}`);
      if (got.large) return exportProblem(`${x.title} is larger than Clawtrate exports (5 MiB).`);
      choices(got.html, framedPage(got.html), b);
    }, 300);
  }
  function exportProblem(text) {
    $("#export-body", dialog).innerHTML = `<p class="export-one" role="alert">${esc(text)}</p><button type="button" class="button" data-size="sm" data-ex="retry">Try again</button>`;
    $('[data-ex="retry"]', dialog).focus();
  }
  function choices(raw, framed, b) {
    const kb = (s) => `${(bytesOf(s) / 1024).toFixed(1)} KB`;
    dialog._files = { shown: framed.html, raw };
    const end =
      (dialog._phone ? `Clawtrate hands the file to the system's share sheet; where it goes from there is your choice.` : `The file is saved on this device; Clawtrate uploads nothing.`) + `</p>`;
    // Compare the UTF-8 bytes: both versions when they differ, one HTML file when they match.
    if (same([...new TextEncoder().encode(raw)], [...new TextEncoder().encode(framed.html)])) {
      $("#export-body", dialog).innerHTML =
        `<div role="radiogroup" aria-label="Which file" class="export-choices"><label class="export-choice"><input type="radio" name="export" value="raw" checked><span><strong>HTML file</strong>` +
        `<span>The page's HTML. ${kb(raw)}.</span></span></label></div><p class="export-foot">The file contains the page's HTML only: files kept beside it on the gateway aren't included. ` +
        end;
      $('[data-ex="save"]', dialog).disabled = false;
      return $("input:checked", dialog).focus();
    }
    $("#export-body", dialog).innerHTML =
      `<div role="radiogroup" aria-label="Which file" class="export-choices">` +
      `<label class="export-choice"><input type="radio" name="export" value="shown" checked><span><strong>${dialog._drawn ? "As shown here" : "Clawtrate version"}</strong>` +
      `<span>Saves the Clawtrate version, with scripts, navigable controls and outside references removed. ${kb(framed.html)}.</span></span></label>` +
      `<label class="export-choice"><input type="radio" name="export" value="raw"><span><strong>As ${esc(b.name)} made it</strong>` +
      `<span>Saves the original HTML. When opened, it can run scripts or contact other sites. ${kb(raw)}.</span></span></label></div>` +
      `<p class="export-foot">Both files contain the page's HTML only: files kept beside it on the gateway aren't included. ` +
      end;
    $('[data-ex="save"]', dialog).disabled = false;
    $("input:checked", dialog).focus();
  }
  function closeExport(refocus = true) {
    if (!dialog) return;
    const back = dialog._opener;
    if (dialog._overShell) $(".shell").inert = false;
    dialog.remove();
    dialog = null;
    if (refocus) (back?.isConnected ? back : $('[data-pv="export"]') || $('[data-ps="share"]'))?.focus();
  }
  function saveExport() {
    const which = $("input:checked", dialog)?.value || "shown";
    if (typeof dialog?._files?.[which] !== "string") return; // nothing to save until this dialog's own read has answered
    const name = dialog._name;
    const bytes = dialog._files[which];
    const err = $(".export-error", dialog);
    if (dialog._phone) {
      if (params.get("sharefail") === "1") {
        err.textContent = `Couldn't open the share sheet. The system said: sharing isn't available right now.`;
        err.hidden = false;
        return;
      }
      // A temporary file on the phone, handed to the system's share sheet. Clawtrate says only that the sheet opened.
      handoffs.push({ name, type: "text/html", bytes, via: "share-sheet" });
      closeExport();
      return CT.announce(`Share sheet opened with ${name}`);
    }
    if (params.get("exportfail") === "1") {
      err.textContent = `Couldn't save ${name}. The system said: there is not enough space on the disk.`;
      err.hidden = false;
      return;
    }
    const blob = new Blob([bytes], { type: "text/html" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // A browser download: the browser chooses where it goes, so only the start is reported. A native write reports "Exported".
    handoffs.push({ name, type: "text/html", bytes, via: "download" });
    closeExport();
    CT.announce(`Download started: ${name}`);
  }

  // The link confirmation (the decision's link row) ---------------------------------------------------

  // One way to open an address, for every surface. direct: the control's text is the whole canonical address, never cut.
  function openLink(raw, from, direct) {
    const href = canonical(raw);
    if (!href) return;
    const near = nearby(href);
    if (direct && !near) return handOff(href);
    confirmLink(href, from, near);
  }
  function handOff(href) {
    opened.push(href);
    CT.toast(phone() ? `Opens ${href} outside Clawtrate.` : `Opens ${href} in your browser.`);
  }
  let confirmBox = null;
  function confirmLink(href, from, near) {
    const u = new URL(href);
    confirmBox?.remove();
    const box = document.createElement("div");
    box.className = "export-dialog lib-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "confirm-title");
    const warn = near === "device" ? "This address points to this device." : near === "network" ? "This address may be on your own network." : "";
    box.innerHTML =
      `<div class="export-card"><h2 id="confirm-title">${esc(u.host)}</h2><p class="confirm-address">${esc(href)}</p>` +
      (warn ? `<p class="confirm-warning">${warn}</p>` : "") +
      `<p class="confirm-where">${phone() ? "Opens outside Clawtrate." : "Opens in your browser."}</p>` +
      `<div class="export-actions"><button type="button" class="button" data-size="sm" data-cf="cancel">Cancel</button><button type="button" class="button" data-size="sm" data-variant="primary" data-cf="open">Open</button></div></div>`;
    $(".app").appendChild(box);
    box._from = from;
    box._href = href;
    confirmBox = box;
    $('[data-cf="cancel"]', box).focus();
  }
  function closeConfirm(open) {
    const box = confirmBox;
    if (!box) return;
    box.remove();
    confirmBox = null;
    if (open) handOff(box._href); // the address that was displayed, exactly
    box._from?.isConnected && box._from.focus();
  }

  // Opening an item ---------------------------------------------------------------------------------

  function openItem(id, from) {
    const b = app.bots.find((x) => x.id === app.model.selectedBot);
    const x = item(id) || itemsFor(b).find((y) => y.id === id);
    if (!x) return;
    L.notice = null;
    if (x.kind === "page") return openPage(x.id, from);
    // A Library row's title is cut to fit, so it never counts as showing the whole address.
    if (x.kind === "link") return openLink(x.href, from, false);
    if (x.src === "uploads") {
      L.notice = `Can't open ${x.title} here: the gateway didn't return its picture.`;
      return rerender();
    }
    if (lost() && !L.cache.has(x.id)) {
      L.notice = "Couldn't reach the gateway. Try again when it's back.";
      rerender();
      return $(`[data-lib-open="${x.id}"]`)?.focus();
    }
    L.cache.add(x.id);
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
  function openHold(id) {
    holdMenu?.remove();
    const x = item(id);
    if (!x || x.src === "uploads") return; // no action: no menu, and focus stays on the row
    const rowEl = $(`.lib-row[data-item="${id}"]`);
    holdMenu = document.createElement("ul");
    holdMenu.className = "menu lib-hold";
    holdMenu.setAttribute("role", "menu");
    holdMenu.setAttribute("aria-label", x.title);
    holdMenu._opener = $(`[data-lib-open="${id}"]`);
    const entries = [];
    entries.push(["open", "Open"]);
    if (x.kind === "page") entries.push(["share", "Share as file…"]);
    if (x.src !== "uploads") entries.push(["pin", isPinned(id) ? "Unpin" : "Pin"]);
    holdMenu.innerHTML = entries.map(([k, label]) => `<li role="none"><button type="button" class="menu-item" role="menuitem" data-hold="${k}" data-item="${esc(id)}">${label}</button></li>`).join("");
    (rowEl || $("#panel-library")).appendChild(holdMenu);
    $(".menu-item", holdMenu).focus();
  }
  function closeHold(refocus) {
    const back = holdMenu?._opener;
    holdMenu?.remove();
    holdMenu = null;
    if (refocus) back?.focus();
  }

  let sheet = null;
  function openPhonePage(x) {
    sheet?.remove();
    const b = botOf(x.task);
    sheet = document.createElement("div");
    sheet.className = "page-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-labelledby", "sheet-title");
    sheet._x = x;
    // No part of the Page is read or drawn here: the iPhone has no rendering path that passes the zero-request check.
    sheet.innerHTML =
      `<header class="page-sheet-bar"><button type="button" class="icon-button" data-ps="close" aria-label="Close" title="Close">${icon("x")}</button>` +
      `<strong id="sheet-title">${esc(x.title)}</strong><span></span></header>` +
      `<div class="page-sheet-body"><p class="page-sheet-sub">Page · ${esc(b.name)} · ${esc(x.time)}</p>` +
      (unconfirmed(x)
        ? `<p class="page-sheet-lead">${esc(unconfirmed(x))}</p>`
        : `<p class="page-sheet-lead">Clawtrate for iPhone can't show pages yet.</p><p>You can ask ${esc(b.name)} about this page, or share it as a file.</p>`) +
      (canWrite()
        ? `<button type="button" class="button" data-variant="primary" data-ps="message">Message about ${esc(x.title)}</button>`
        : `<button type="button" class="button" data-variant="primary" data-ps="request-access">Request access to message</button>`) +
      (unconfirmed(x) ? "" : `<button type="button" class="button" data-ps="share">Share as file…</button>`) +
      `</div>`;
    $(".app").appendChild(sheet);
    $(".shell").inert = true;
    $('[data-ps="close"]', sheet).focus();
  }
  function closePhonePage(andThen) {
    if (!sheet) return;
    sheet.remove();
    sheet = null;
    $(".shell").inert = false;
    if (openerScroll !== null && $("#transcript")) $("#transcript").scrollTop = openerScroll;
    if (andThen) andThen();
    else if (opener?.isConnected) opener.focus();
    else if (opener?.dataset?.libOpen) $(`[data-lib-open="${opener.dataset.libOpen}"]`)?.focus();
  }
  function messageAbout(x) {
    closePhonePage(() => {
      app.setPanel(false);
      const field = () => $(".composer-input");
      const focusEnd = () => {
        const f = field();
        if (!f) return;
        f.value = app.model.drafts[x.task] || "";
        f.focus();
        f.setSelectionRange(f.value.length, f.value.length);
      };
      offerPrefix(x, focusEnd);
    });
  }

  // Wiring ---------------------------------------------------------------------------------------------

  CT.openPage = openPage;

  // A fulfilled long press swallows the click its release makes.
  document.addEventListener(
    "click",
    (event) => {
      // Only the click that belongs to a completed hold, on its own row, is consumed.
      if (L.swallow) {
        const held = L.swallow;
        L.swallow = null;
        if (event.target.closest?.("[data-lib-open]") === held.row) {
          event.preventDefault();
          event.stopImmediatePropagation();
          return;
        }
      }
      // Page cards in the conversation open through the same gate as everything else.
      const card = event.target.closest('[data-viewer="page"], [data-open-page]');
      if (!card) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openPage(card.dataset.openPage || "pj", card);
    },
    true,
  );

  document.addEventListener("input", (event) => {
    if (event.target.id === "page-chat-input" && view) app.model.drafts[view._x.task] = event.target.value;
  });

  function requestAccess() {
    L.access = "asking";
    renderAccess();
    setTimeout(() => {
      if (L.access !== "asking") return;
      L.access = "requested";
      renderAccess();
    }, 300);
  }
  function owner(decision) {
    if (L.access !== "requested") return;
    if (decision === "approve") {
      app.model.access = "write";
      L.access = null;
      $$(".lib-access").forEach((el) => el.remove());
      CT.announce("Access granted");
      // A request from Chat puts focus in the composer; one from Pin returns to Pin, which waits to be chosen again.
      const fromChat = L.accessFor === "chat";
      if (view) {
        refreshChat();
        (fromChat ? $("#page-chat-input") : $('[data-pv="pin"]', view))?.focus();
      } else if (sheet) {
        openPhonePage(sheet._x);
        $(fromChat ? '[data-ps="message"]' : '[data-ps="close"]', sheet)?.focus();
      } else {
        rerender();
        ($(`[data-lib-pin="${L.accessItem}"]`) || $(`[data-lib-open="${L.accessItem}"]`))?.focus();
      }
      return;
    }
    L.access = decision === "deny" ? "denied" : "expired";
    renderAccess();
  }

  document.addEventListener("click", (event) => {
    const t = event.target;
    if (holdMenu && !t.closest(".lib-hold")) closeHold(false);
    const dr = t.closest("[data-dr]");
    if (dr) return closeDraft(dr.dataset.dr);
    if (t.closest("[data-access]")) return requestAccess();
    const hold = t.closest("[data-hold]");
    if (hold) {
      const id = hold.dataset.item;
      const what = hold.dataset.hold;
      const back = holdMenu?._opener;
      closeHold(false);
      if (what === "open") return openItem(id, back);
      if (what === "pin") return togglePin(id, back);
      if (what === "share") return openExport(item(id), back);
    }
    const ps = t.closest("[data-ps]")?.dataset.ps;
    if (ps === "close") return closePhonePage();
    if (ps === "share") return openExport(sheet._x, t.closest("[data-ps]"));
    if (ps === "message") return messageAbout(sheet._x);
    if (ps === "request-access") {
      L.accessFor = "chat";
      L.access = "read";
      return requestAccess();
    }
    const cf = t.closest("[data-cf]");
    if (cf) return closeConfirm(cf.dataset.cf === "open");
    const ex = t.closest("[data-ex]")?.dataset.ex;
    if (ex === "cancel") return closeExport();
    if (ex === "save") return saveExport();
    if (ex === "retry") return readForExport(dialog._x, botOf(dialog._x.task));
    const pv = t.closest("[data-pv]");
    if (pv && view) {
      const what = pv.dataset.pv;
      if (what === "close") return closePage();
      if (what === "export") return openExport(view._x, pv);
      if (what === "pin") return togglePin(view.dataset.item, pv);
      if (what === "links") return openLinks(pv);
      if (what === "open-link") {
        const back = menu?._opener;
        closeMenu();
        openLink(pv.dataset.href, back, true); // the menu item's text is the whole address
        return confirmBox ? undefined : back?.focus();
      }
      if (what === "retry") {
        $("#page-stage").innerHTML = `<p class="page-state" aria-busy="true">Loading ${esc(view._x.title)}…</p>`;
        return setTimeout(loadPage, 300, view);
      }
      if (what === "chat" || what === "chat-close") {
        const hidden = what === "chat-close" ? true : !view.classList.contains("chat-hidden");
        view.classList.toggle("chat-hidden", hidden);
        const toggle = $('[data-pv="chat"]', view);
        toggle.setAttribute("aria-pressed", String(!hidden));
        toggle.setAttribute("aria-label", hidden ? "Show the chat" : "Hide the chat");
        if (hidden) return what === "chat-close" ? toggle.focus() : undefined;
        return offerPrefix(view._x);
      }
      if (what === "send") {
        const field = $("#page-chat-input");
        const x = view._x;
        app.model.drafts[x.task] = field.value;
        if (!app.send()) return field.focus(); // the conversation's own send: its checks, its outbox, its transcript
        refreshSideLog(); // drawn from that transcript, so both views show the same pending, then confirmed, message
        field.value = app.model.drafts[x.task] || "";
        return field.focus();
      }
      if (what === "request-access") {
        L.accessFor = "chat";
        L.access = "read";
        return requestAccess();
      }
    }
    if (!t.closest("#panel-library")) return;
    const pin = t.closest("[data-lib-pin]");
    if (pin) return togglePin(pin.dataset.libPin, pin);
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
      const before = $$(`.lib-group[data-group="${g}"] .lib-row`).length;
      L.shown[g] = (L.shown[g] || 5) + 5;
      rerender();
      // The button stays where it is while more remain; after the last batch, focus goes to the first row it revealed.
      return ($(`[data-lib-more="${g}"]`) || $$(`.lib-group[data-group="${g}"] [data-lib-open]`)[before])?.focus();
    }
    const action = t.closest("[data-lib]")?.dataset.lib;
    if (lost() && ["look", "retry", "refresh"].includes(action)) return; // these come back when the gateway does
    if (action === "look") {
      const b = app.bots.find((x) => x.id === app.model.selectedBot);
      L.read += 10;
      const tasks = readTasks(b);
      const cov = coverage(b, tasks, false);
      rerender();
      CT.announce(`Read ${cov.confirmed} of ${b.name}'s ${tasks.all.length} tasks in full`);
      return $("#lib-fresh button")?.focus();
    }
    if (action === "retry" || action === "refresh") {
      L.lib = "loaded";
      return rerender();
    }
  });

  // Touch and hold on the phone: half a second without moving, or the system's context menu.
  let press = null;
  const cancelPress = () => {
    if (press) clearTimeout(press.timer);
    press = null;
  };
  document.addEventListener("pointerdown", (event) => {
    const r = event.target.closest?.("#panel-library [data-lib-open]");
    L.swallow = null; // a new press clears any record of the last one
    if (!r || !phone()) return;
    cancelPress();
    press = { x: event.clientX, y: event.clientY, fired: false, row: r, pointerId: event.pointerId };
    press.timer = setTimeout(() => {
      press.fired = true;
      openHold(r.dataset.libOpen);
    }, 500);
  });
  document.addEventListener("pointermove", (event) => {
    if (press && !press.fired && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress();
  });
  document.addEventListener("pointercancel", cancelPress);
  document.addEventListener("scroll", () => press && !press.fired && cancelPress(), true);
  document.addEventListener("pointerup", (event) => {
    // The release of a completed hold, by the same pointer, and the click it makes on that row belong to the menu.
    if (press?.fired && event.pointerId === press.pointerId) L.swallow = { row: press.row, pointerId: press.pointerId };
    if (press) clearTimeout(press.timer);
    press = null;
  });
  document.addEventListener("contextmenu", (event) => {
    const r = event.target.closest?.("#panel-library [data-lib-open]");
    if (!r || !phone()) return;
    event.preventDefault();
    if (!holdMenu) openHold(r.dataset.libOpen);
  });

  // The topmost open dialog; Tab and Shift+Tab stay in it.
  const topmost = () => draftBox || confirmBox || dialog || sheet || view;

  document.addEventListener(
    "keydown",
    (event) => {
      const t = event.target;
      const inMenu = t.closest?.('[role="menu"]');
      if (inMenu && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const items = $$('[role="menuitem"]', inMenu);
        const i = items.indexOf(t);
        const n = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        return items[n].focus();
      }
      if (event.key === "Escape") {
        // Escape belongs to the Library only while one of its menus or dialogs is open; otherwise its owner handles it.
        if (!holdMenu && !menu && !topmost()) return;
        event.stopImmediatePropagation();
        if (holdMenu) return closeHold(true);
        if (menu) {
          const back = menu._opener;
          closeMenu();
          return back?.focus();
        }
        if (draftBox) return closeDraft("keep");
        if (confirmBox) return closeConfirm(false);
        if (dialog) return (event.preventDefault(), closeExport());
        if (sheet) return closePhonePage();
        if (view) {
          event.preventDefault();
          if (t.id === "page-chat-input" && t.value.trim()) return (t.blur(), $('[data-pv="chat"]').focus());
          return closePage();
        }
        return;
      }
      if (view && !dialog && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "e") {
        event.preventDefault();
        return openExport(view._x, $('[data-pv="export"]', view));
      }
      // Enter sends from the side composer as from the conversation's (conversation.md, section 15); Shift+Enter is a new line.
      if (view && t.id === "page-chat-input" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        return $('[data-pv="send"]').click();
      }
      // The phone's menu from a keyboard: Shift+F10 or the context-menu key on a focused row.
      if (phone() && t.dataset?.libOpen && ((event.shiftKey && event.key === "F10") || event.key === "ContextMenu")) {
        event.preventDefault();
        return openHold(t.dataset.libOpen);
      }
      if (event.key === "Tab" && topmost()) {
        const box = topmost();
        let focusables = $$("button:not([disabled]), textarea, input:not([type=radio]), input[type=radio]:checked, iframe, [tabindex]:not([tabindex='-1'])", box).filter(
          (el) => el.getClientRects().length && !el.closest("[inert]"),
        );
        // A dialog over the Page view covers it: only the dialog's own controls count.
        for (const cover of [draftBox, confirmBox, dialog]) if (cover && cover !== box) focusables = focusables.filter((el) => !cover.contains(el));
        if (box === view && dialog) focusables = focusables.filter((el) => dialog.contains(el));
        if (!focusables.length) return;
        const i = focusables.indexOf(document.activeElement);
        if (i === -1) {
          event.preventDefault();
          return focusables[event.shiftKey ? focusables.length - 1 : 0].focus();
        }
        if (event.shiftKey && i === 0) {
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
        `<button type="button" data-libbar="approve">Owner approves access</button><button type="button" data-libbar="deny">Owner denies access</button>` +
        `<span id="run-caption">Open Marlow's Work pane, then Library.</span></span>`;
    });
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-libbar]")?.dataset.libbar;
      if (what === "other") {
        anotherDeviceWrites();
        prefsChanged();
      }
      if (what === "approve" || what === "deny") owner(what);
    });
  });

  CT.library = { L, G, P, ITEMS, PAGES, counters, opened, handoffs, framedPage, canonical, nearby, pic, rerender, prefsChanged, owner, fileName };

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
      const art = { i2: pic("#e9efe7", "#58c26f", "Ridge profile"), i3: pic("#dfe7f0", "#5b8dff", "Trail photo"), i8: pic("#f4ece4", "#ff8552", "Newsletter header"), i11: pic("#232428", "#a98bff", "Ridge at dawn"), i10: pic("#16181b", "#3ee6c1", "Ridge walk") };
      for (const x of ITEMS) {
        if (x.kind === "page" || x.kind === "link" || x.src === "uploads") continue;
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
    connectionChanged(name) {
      base.connectionChanged?.(name);
      if (!app) return;
      if (name === "connected") reconnected();
      rerender();
    },
    ready(a) {
      app = a;
      base.ready?.(a);
      // Whenever the conversation's transcript changes (a send, a queued message settling on reconnect), the side chat follows.
      const transcript = $("#transcript");
      if (transcript) new MutationObserver(() => refreshSideLog()).observe(transcript, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-waiting"] });
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
      W.turn("user", W.bubble("user", "Plan Saturday's hike. Here are the maps I have, and the trailhead: https://maps.example/trailhead")) +
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
