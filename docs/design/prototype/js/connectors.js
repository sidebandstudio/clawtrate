// Behaviour for connectors.html: every screen of docs/design/connectors.md,
// chosen with ?screen=<id> (SCREENS below; the README lists the parameters).
// Nothing is contacted and nothing is installed. Each action goes where the
// real one would lead, so every path can be walked to its outcome by clicking.
//
// What the gateway answers is chosen in a dashed "Prototype" box, which is not
// product. Every connector here has an invented name and a drawn initial.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const screen = params.get("screen") || "home";
  const access = params.get("access") || "admin"; // read, interactive, admin
  const req = params.get("req") || ""; // asking, requested, denied, expired, granted
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Every display setting and the access tier are kept when moving between screens.
  const KEEP = ["theme", "width", "motion", "chrome", "access", "picked", "device", "readonly", "skills", "marked"];
  // On the iPhone the window is "Plugins" (F-380), with its own words.
  const iphone = params.get("device") === "iphone";
  const go = (to, extra = {}) => {
    const next = new URLSearchParams([...params].filter(([k]) => KEEP.includes(k)));
    next.set("screen", to);
    for (const [key, value] of Object.entries(extra)) if (value !== null) next.set(key, value);
    return `connectors.html?${next}`;
  };
  // The gateway's own read-only configuration (mutationAllowed: false), whatever this device's access.
  const readonlyGw = params.get("readonly") === "1";
  const admin = (access === "admin" || req === "granted") && !readonlyGw;
  const readonlyNote = () => (readonlyGw ? `<div class="b-note" role="status">${CT.icon("lock")}<div><p><b>This gateway's settings are read-only.</b> Plugins can't be added, turned on or off, or removed here, from any app.</p></div></div>` : "");

  // Samples --------------------------------------------------------------------------

  const CATEGORIES = [
    ["productivity", "Productivity"],
    ["files", "Files"],
    ["finance", "Finance"],
    ["mail", "Mail"],
    ["developer-tools", "Developer tools"],
  ];
  const APPS = [
    { id: "quillnote", name: "Quillnote", summary: "Notes and notebooks your bots can read and add to.", author: "quillnote-labs", cats: ["productivity"], featured: true, version: "2.4.1", local: "install", servers: [["quillnote", true]], skills: ["Daily notes"], host: "auth.quillnote.example", readme: "Quillnote keeps notes in notebooks. With this connector a bot can search your notes, read a page and add one.\nIt signs in to your Quillnote account with OAuth; the gateway keeps the sign-in." },
    { id: "tasktide", name: "Tasktide", summary: "Tasks, due dates and lists.", author: "tasktide", official: true, cats: ["productivity"], featured: true, version: "1.9.0", local: "enabled", servers: [["tasktide", true]], auth: "authorized", host: "auth.tasktide.example" },
    { id: "calendrop", name: "Calendrop", summary: "Calendars and free time.", author: "calendrop", cats: ["productivity"], featured: true, version: "3.0.2", local: "enabled", servers: [["calendrop", true]], auth: "unauthenticated", host: "auth.calendrop.example" },
    { id: "chartwick", name: "Chartwick", summary: "Dashboards and charts from your sheets.", author: "chartwick", official: true, cats: ["productivity"], version: "0.8.0", local: "install", servers: [["chartwick", false]] },
    { id: "ledgerkin", name: "Ledgerkin", summary: "Invoices and expenses, read-only.", author: "ledgerkin", cats: ["finance"], version: "1.2.0", local: "disabled", servers: [["ledgerkin", true]] },
    { id: "boxwharf", name: "Boxwharf", summary: "Files and shared folders.", author: "boxwharf", cats: ["files"], featured: true, version: "2.1.0", local: "error", error: "boxwharf-sync: the token store couldn't be read" },
    { id: "postlark", name: "Postlark", summary: "Mail: read, draft and file messages.", author: "postlark", cats: ["mail"], version: "1.0.4", local: "needs-setup", missing: ["Account address"] },
    { id: "docklet", name: "Docklet", summary: "Docs and wikis.", author: "docklet", cats: ["productivity"], version: "0.3.0", local: "unavailable" },
    { id: "linkpeek", name: "Linkpeek", summary: "Previews of links in replies.", bundled: true, cats: ["developer-tools"], version: "2026.10.6", local: "enabled" },
    { id: "voicewell", name: "Voicewell", summary: "Speech for replies read aloud.", bundled: true, cats: ["developer-tools"], version: "2026.10.6", local: "disabled" },
    { id: "pathfinder", name: "Pathfinder", summary: "A coarse place from a network address.", bundled: true, cats: ["developer-tools"], version: "2026.10.6", local: "enabled" },
  ];
  // The next page of the overview, after "Show more" (the gateway's nextCursor).
  const MORE = [
    { id: "mapwhistle", name: "Mapwhistle", summary: "Places, routes and travel times.", author: "mapwhistle", cats: ["productivity"], version: "1.1.0", local: "install" },
    { id: "tunebarrow", name: "Tunebarrow", summary: "Playlists and listening history.", author: "tunebarrow", cats: ["productivity"], version: "0.9.2", local: "install" },
  ];
  const SKILLS = [
    { name: "Weekly review", text: "Collect the week's notes and tasks into one summary." },
    { name: "Meeting notes", text: "Write up a meeting from its notes, with actions." },
  ];
  // The twelve tiles of "What do you use every day?": the catalog's featured apps.
  const TILES = ["Quillnote", "Tasktide", "Calendrop", "Boxwharf", "Chartwick", "Postlark", "Ledgerkin", "Docklet", "Mapwhistle", "Tunebarrow", "Sketchpond", "Huddlewick"];
  const SERVERS = {
    "notes-work": { kind: "remote", url: "https://notes.example/mcp", headers: ["Authorization", "X-Workspace"], signin: "oauth", last: "tools" },
    "search-index": { kind: "command", command: "/opt/example/bin/search-server", args: ["--stdio", "--index", "./notes"], last: "unavailable" },
    "team-notes": { kind: "remote", url: "https://teamnotes.example/mcp", headers: [], signin: "each", last: "notyet" },
  };
  // ?marked=1: gateway strings that carry inert markup, which must render as text (section 6).
  if (params.get("marked") === "1") {
    Object.assign(APPS[0], { name: "Quillnote <em>beta</em>", summary: "Notes <em>and</em> notebooks.", author: "quillnote-<em>labs</em>", refusal: "fetch failed <em>offline</em>" });
    APPS.find((a) => a.id === "postlark").missing = ["<em>Account</em> address"];
    SERVERS["notes-work"].diagnostic = "fetch failed <em>refused</em>";
  }
  const app = (id) => APPS.find((a) => a.id === id) || APPS[0];
  // The page's own memory for one operation: the untouched form, the reviewed draft and what was saved.
  // It lives in this tab's session storage and never in an address. Header values are never kept.
  const store = {
    get(key) {
      try {
        return JSON.parse(sessionStorage.getItem(`ct-connectors-${key}`) || "null");
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        sessionStorage.setItem(`ct-connectors-${key}`, JSON.stringify(value));
      } catch {
        /* private window: the walk still works within this page */
      }
    },
  };
  const draft = () => store.get("draft") || { type: params.get("type") || "remote", raw: {}, reviewed: null };
  const saved = () => store.get("saved") || {};
  const serverOf = (name) => SERVERS[name] || saved()[name] || SERVERS["notes-work"];
  const known = (name) => Boolean(SERVERS[name] || saved()[name]);
  const picked = (params.get("picked") || "").split(",").filter(Boolean);

  // Pieces -----------------------------------------------------------------------------

  const initial = (name, size = "") => `<span class="c-initial"${size ? ` data-size="${size}"` : ""} aria-hidden="true">${esc(name[0])}</span>`;
  const link = (label, to, extra = {}, { variant, size = "sm", attrs = "" } = {}) =>
    `<a class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}" href="${esc(go(to, extra))}"${attrs ? ` ${attrs}` : ""}>${esc(label)}</a>`;
  const pill = (text, tone = "") => `<span class="c-pill"${tone ? ` data-tone="${tone}"` : ""}>${esc(text)}</span>`;
  const note = (tone, lead, text, extra = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="${tone === "danger" ? "alert" : "status"}">` +
    `${icon(tone ? "warning" : "clock")}<div><p>${lead ? `<b>${esc(lead)}</b>` : ""}${lead && text ? " " : ""}${esc(text)}</p>${extra}</div></div>`;
  const group = (text) => `<h4 class="b-group">${esc(text)}</h4>`;
  const facts = (rows) => `<dl class="facts c-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const copyButton = (label, text) =>
    `<button type="button" class="copy" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const command = (text, label) => `<div class="command-line"><code>${esc(text)}</code>${copyButton(label, text)}</div>`;
  const result = (tone, mark, title, text, actions = "") =>
    `<div class="b-result c-result"><span class="empty-mark"${tone ? ` data-tone="${tone}"` : ""}>${icon(mark)}</span>` +
    `<h3>${esc(title)}</h3><p>${text}</p>${actions ? `<div class="b-actions c-actions">${actions}</div>` : ""}</div>`;
  const proto = (label, buttons) =>
    `<div class="c-proto" role="group" aria-label="Prototype"><span>Prototype: ${label}</span>${buttons.join("")}</div>`;
  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(([text, state]) => {
        const mark = state === "done" ? icon("check") : state === "failed" ? icon("x") : "";
        return `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${state}"><span class="s-step-mark">${mark}</span><span>${esc(text)}</span><span class="s-step-time"></span></li>`;
      })
      .join("") +
    `</ol>`;
  const goes = (gone, stays, read = null) =>
    `<div class="c-goes"><h4>Goes</h4><ul>${gone.map((t) => `<li data-mark="${read ? read : "goes"}">${icon(read ? "check" : "x")}<span>${esc(t)}</span></li>`).join("")}</ul>` +
    `<h4>Stays</h4><ul>${stays.map((t) => `<li data-mark="stays">${icon("check")}<span>${esc(t)}</span></li>`).join("")}</ul></div>`;

  // The access bar of bots.md §2, in an admin action's place.
  const accessBar = (what) => {
    if (admin || readonlyGw) return "";
    const state = req || (access === "read" ? "read" : "interactive");
    const rows = {
      read: [`${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${what}</span>`, link("Request admin access", screen, keepHere({ req: "asking" }), { variant: "primary" })],
      interactive: [`${icon("eye")}<span class="shelf-text"><b>Admin access needed.</b> ${what}</span>`, link("Request admin access", screen, keepHere({ req: "asking" }), { variant: "primary" })],
      asking: [`<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`, ""],
      requested: [`<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span>`, ""],
      denied: [`<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device keeps the access it had.</span>`, link("Request again", screen, keepHere({ req: "asking" }))],
      expired: [`<span class="shelf-text"><b>The request expired</b> before it was approved.</span>`, link("Request again", screen, keepHere({ req: "asking" }))],
    };
    const [text, actions] = rows[state] || rows.read;
    return (
      `<section class="access-bar c-access" role="region" aria-label="Access" data-state="${state}"><div class="access-row">${text}${actions}</div>` +
      (state === "asking" ? proto("the gateway", [link("Files the request", screen, keepHere({ req: "requested" }), { variant: "quiet" })]) : "") +
      (state === "requested"
        ? command("openclaw devices approve 3f9a2c71", "approve command") +
          `<div class="access-row"><span class="access-id">Request <span class="mono">3f9a2c71</span>${copyButton("request id", "3f9a2c71")}</span></div>` +
          proto("the owner", [link("Approves", screen, keepHere({ req: "granted" }), { variant: "quiet" }), link("Denies", screen, keepHere({ req: "denied" }), { variant: "quiet" }), link("Lets it expire", screen, keepHere({ req: "expired" }), { variant: "quiet" })])
        : "") +
      `</section>`
    );
  };
  const keepHere = (extra) => {
    const here = {};
    for (const key of ["id", "q", "cat", "type", "last", "card"]) if (params.get(key)) here[key] = params.get(key);
    return { ...here, ...extra };
  };
  const granted = () => (req === "granted" ? note("", "Admin access granted.", "You can change this now.") : "");

  // A catalog row and its end, from its `local` facts (section 4).
  const rowEnd = (a) => {
    if (a.local === "install") return admin ? link("Add", "add-confirm", { id: a.id }, { attrs: `aria-label="Add ${esc(a.name)}"` }) : "";
    if (a.local === "unavailable") return `<span class="c-faint">Not available</span>`;
    return statePill(a);
  };
  const statePill = (a) =>
    ({ enabled: pill("Added"), disabled: pill("Turned off"), "needs-setup": pill("Needs setup", "warn"), error: pill("Not working", "danger") })[a.local] || "";
  const row = (a, to = "app") => {
    const state = a.local === "install" ? "Add" : a.local === "unavailable" ? "Not available" : { enabled: "Added", disabled: "Turned off", "needs-setup": "Needs setup", error: "Not working" }[a.local];
    return (
      `<li class="c-row" data-app="${a.id}"><a class="c-row-main" href="${esc(go(a.local === "install" || a.local === "unavailable" ? "app" : to, { id: a.id }))}" aria-label="${esc(`${a.name}, ${state}, ${a.summary}`)}">` +
      `${initial(a.name)}<span class="c-row-text"><span class="c-row-name">${esc(a.name)}</span><span class="c-row-sub">${a.bundled ? "Comes with OpenClaw · " : ""}${esc(a.summary)}</span></span></a>` +
      `<span class="c-row-end">${rowEnd(a)}</span></li>`
    );
  };
  const rows = (list, to) => `<ul class="c-rows">${list.map((a) => row(a, to)).join("")}</ul>`;

  // The window ------------------------------------------------------------------------

  const NAV = [
    ["browse", "Browse"],
    ["installed", "On this gateway"],
    ["add-server", "Add a custom connector"],
  ];
  const navOf = (s) =>
    s.startsWith("browse") || s.startsWith("app") || s.startsWith("add-") && !s.startsWith("add-server") ? "browse" : s.startsWith("add-server") || s === "command-confirm" || (s.startsWith("write-") && params.get("op") !== "remove") ? "add-server" : "installed";
  const windowHtml = ({ title, body, back, foot = "", pane = "section", label }) => {
    const current = navOf(screen);
    return (
      `<div class="c-scrim"><div class="c-window" role="dialog" aria-modal="true" aria-labelledby="c-window-title">` +
      `<h2 class="visually-hidden" id="c-window-title">${label || (iphone ? "Plugins" : "Connect apps")}</h2>` +
      `<div class="c-frame" data-pane="${pane}">` +
      `<nav class="c-nav" aria-label="Connect apps"><div class="c-nav-head"><p class="c-nav-title">${label || (iphone ? "Plugins" : "Connect apps")}</p>` +
      `<a class="icon-button c-close" href="${esc(go("home"))}" aria-label="Close">${icon("x")}</a></div>` +
      NAV.filter(([id]) => !(iphone && id === "add-server")).map(([id, text]) => `<a class="c-nav-item" href="${go(id)}"${id === current ? ' aria-current="page"' : ""}>${text}${icon("chevron")}</a>`).join("") +
      `</nav>` +
      `<section class="c-section" aria-labelledby="c-section-title">` +
      `<div class="c-section-head">${back ? `<a class="icon-button c-back" href="${back}" aria-label="Back">${icon("back")}</a>` : `<a class="icon-button c-back c-to-nav" href="${go("nav")}" aria-label="Back">${icon("back")}</a>`}` +
      `<h3 id="c-section-title" tabindex="-1">${esc(title)}</h3><a class="icon-button c-close" href="${go("home")}" aria-label="Close">${icon("x")}</a></div>` +
      `<div class="c-section-body">${body}</div>${foot ? `<div class="c-section-foot">${foot}</div>` : ""}` +
      `</section></div></div></div>`
    );
  };
  const confirm = (title, text, buttons, extra = "") =>
    `<div class="c-scrim c-scrim-top"><div class="c-confirm" role="alertdialog" aria-modal="true" aria-labelledby="c-confirm-title" aria-describedby="c-confirm-text">` +
    `<h2 id="c-confirm-title">${esc(title)}</h2><div id="c-confirm-text">${text}</div>${extra}<div class="b-actions c-actions">${buttons.join("")}</div></div></div>`;

  // Browse (sections 4 and 5) -------------------------------------------------------------

  const search = (placeholder, value = "") =>
    `<div class="c-search" role="search"><span class="c-search-icon">${icon("search")}</span>` +
    `<input class="input" type="search" id="c-q" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(value)}" autocomplete="off" /></div>`;
  const chips = (chosen) =>
    `<div class="c-chips" role="radiogroup" aria-label="Categories">` +
    [["", "All"], ...CATEGORIES]
      .map(([slug, label]) => `<a class="c-chip" id="chip-${slug || "all"}" data-slug="${slug}" role="radio" aria-checked="${chosen === slug}" tabindex="${chosen === slug ? 0 : -1}" href="${go(slug ? "browse-category" : "browse", slug ? { cat: slug } : {})}">${label}</a>`)
      .join("") +
    `</div>`;
  const browseLoaded = () => {
    const pickedRows = APPS.filter((a) => picked.includes(a.name));
    return (
      readonlyNote() +
      search(iphone ? "Search plugins" : "Search across apps and skills") +
      chips("") +
      `<div id="c-results">` +
      (pickedRows.length ? group("You picked") + rows(pickedRows) : "") +
      group(iphone ? "Featured" : "Recommended for you") +
      `<p class="c-line">Featured in the catalog.</p>` +
      rows(APPS.filter((a) => a.featured)) +
      group("All apps") +
      rows(APPS) +
      (params.get("more") === "1" ? rows(MORE) : `<div class="c-actions">${link("Show more", "browse", { more: "1" })}</div>`) +
      `</div>` +
      accessBar("Adding apps needs admin access.") +
      granted()
    );
  };
  const browseOffline = () =>
    note(
      "",
      "The catalog can't be reached from the gateway.",
      "You can still see and manage what's on this gateway. Apps to add come back when the gateway can reach the catalog.",
      `<details class="c-details"><summary>Details</summary><p class="c-faint">ClawHub is unavailable: fetch failed. Installed plugins remain available.</p></details>` +
        `<div class="c-actions">${link("Try again", "browse-retry")}</div>`,
    ) +
    search("Search what's on this gateway") +
    `<p class="c-line" data-c="no-chips">Categories and recommendations come from the catalog.</p>` +
    `<div id="c-results">` +
    group("On this gateway") +
    rows(APPS.filter((a) => a.local !== "install" && a.local !== "unavailable"), "connector") +
    `</div>`;

  // A connector's page (section 8) -------------------------------------------------------

  const connectorState = (a) => {
    const off = params.get("now") === "off" || (a.local === "disabled" && params.get("now") !== "on");
    if (off) return ["Turned off. Its tools aren't offered to any bot.", [admin ? link("Turn on", "connector", { id: a.id, now: "on", said: "on" }) : ""]];
    if (a.local === "needs-setup") return [`Needs setup. Open Settings on the gateway to finish setup.${a.missing?.length ? ` The gateway reports missing: ${a.missing.join(", ")}.` : ""}`, []];
    if (a.local === "error") return [`Not working: ${a.error}`, [admin ? link("Turn off", "turnoff-confirm", { id: a.id }) : ""]];
    if (a.bundled) return ["Added. Not loaded yet: it loads when a bot first needs it.", [admin ? link("Turn off", "turnoff-confirm", { id: a.id }) : ""]];
    return ["Added", [admin ? link("Turn off", "turnoff-confirm", { id: a.id }) : ""]];
  };
  const accountRow = (a) => {
    const off = params.get("now") === "off" || (a.local === "disabled" && params.get("now") !== "on");
    if (!a.servers || !a.servers.some(([, oauth]) => oauth)) return "";
    if (off) return group("Accounts") + `<p class="c-line">The gateway reports sign-ins only while ${esc(a.name)} is turned on.</p>`;
    const state = params.get("auth") || a.auth || "unauthenticated";
    const words = {
      unauthenticated: pill("Needs sign-in.", "warn"),
      "requires-authorization": pill("Needs sign-in again.", "warn"),
      "pending-authorization": `<span>Sign-in pending.</span>`,
      authorized: `<span><b>Signed in.</b> The gateway reports saved sign-in tokens.</span><span class="c-faint">Whether they still work isn't reported.</span>`,
      none: `<span>Sign-in status not reported.</span>`,
    }[state];
    return (
      group("Accounts") +
      `<ul class="c-rows"><li class="c-account"><span class="c-row-text"><span class="c-row-name"><span class="mono">${esc(a.servers.find(([, o]) => o)[0])}</span> · Shared by everyone on this gateway</span><span class="c-row-sub c-account-state">${words}</span></span>` +
      `<span class="c-row-end"></span></li></ul>` +
      `<p class="c-line" data-c="settings">Open Settings on your OpenClaw gateway to sign in to ${esc(a.servers.find(([, o]) => o)[0])}.</p>` +
      `<div class="c-actions">${link("Check again", "connector", { id: a.id, checked: "1", ...(params.get("auth") ? { auth: params.get("auth") } : {}) })}</div>` +
      (params.get("checked") ? `<p class="c-line">Read again at 5:12 PM.</p>` : "")
    );
  };
  const connectorPage = () => {
    const a = app(params.get("id") || "tasktide");
    const [state, actions] = connectorState(a);
    const said = params.get("said");
    const removable = !a.bundled;
    return {
      title: a.name,
      back: go("installed"),
      body:
        readonlyNote() +
        (params.get("busy") === "1" ? note("warn", "The gateway is busy with another change.", "Try again in a moment.", `<div class="c-actions">${link("Try again", "turnoff-confirm", { id: a.id })}</div>`) : "") +
        (said === "on" ? note("", `Turned on ${a.name}.`, `The gateway lists it as added.`) : said === "off" ? note("", `Turned off ${a.name}.`, "The gateway lists it as turned off.") : "") +
        `<div class="c-hero">${initial(a.name, "lg")}<div><p class="c-hero-name">${esc(a.name)}</p><p class="c-faint">${a.bundled ? "Comes with OpenClaw" : `by ${esc(a.author)}`} · ${esc(a.version)}</p></div></div>` +
        `<p class="c-state" data-c="state">${esc(state)}</p>` +
        `<p class="c-text">${esc(a.summary)}</p>` +
        (a.bundled ? `<p class="c-line">Comes with OpenClaw, so it can be turned off but not removed.</p>` : "") +
        group("Tools") +
        `<ul class="c-list">${(a.servers || [[a.id, false]]).map(([s]) => `<li><span class="mono">${esc(s)}</span>, a tool server</li>`).join("")}${(a.skills || []).map((k) => `<li>${esc(k)}, a skill</li>`).join("")}</ul>` +
        `<p class="c-line">Which bots may use these is in each bot's settings.</p>` +
        accountRow(a) +
        `<div class="c-actions">${actions.join("")}${removable && admin ? link("Remove…", "remove-confirm", { id: a.id }, { variant: "quiet" }) : ""}</div>` +
        accessBar("Changing connectors needs admin access.") +
        granted(),
    };
  };

  // A tool server's page (section 9) ------------------------------------------------------

  const serverPage = () => {
    const name = params.get("id") || "notes-work";
    const s = serverOf(name);
    const last = params.get("last") || s.last || "notyet";
    const lastRun = {
      tools: `<p class="c-state">Gateway tool listing for Pip's task, read at 5:12 PM: 8 tools</p><details class="c-details"><summary>The tools</summary><p class="mono c-faint">${esc(name)}__search, ${esc(name)}__read_page, ${esc(name)}__add_page, …</p></details>`,
      notyet: `<p class="c-state">The gateway hasn't listed this server's tools for this task.</p><details class="c-details"><summary>The gateway's notice</summary><p class="c-faint">MCP servers "${esc(name)}" are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them.</p></details>`,
      unavailable: `<p class="c-state" data-tone="warn">Gateway tool listing for Pip's task, read at 5:12 PM:</p><p class="mono c-warn">${esc(`MCP server "${name}": ${s.kind === "command" ? `spawn ${s.command} ENOENT` : s.diagnostic || "fetch failed | connect ECONNREFUSED"}; server unavailable.`)}</p>`,
      none: `<p class="c-state">Not reported: the gateway's tool listing for this task doesn't mention this server.</p>`,
    }[last];
    const rowsList = [
      ["Name on the gateway", `<span class="mono">${esc(name)}</span>`],
      ["Kind", s.kind === "remote" ? "Added by address" : "Runs a command"],
      ...(s.kind === "remote"
        ? [
            ["Address", `<span class="mono">${esc(s.url)}</span>`],
            ["Headers", s.headers.length ? `${s.headers.map((h) => `<span class="mono">${esc(h)}</span>`).join(", ")}. Hidden: the gateway doesn't show saved values. Kept by the gateway in its settings file, not encrypted there.` : "None"],
            ["Sign-in", s.signin === "oauth" ? "Signs in with OAuth" : s.signin === "each" ? "Uses the gateway\'s requester sign-in. Set up and use it in a channel where the gateway identifies each sender." : "None"],
          ]
        : [
            ["Program", `<span class="mono" data-c="program">${esc(s.command)}</span>`],
            ["Arguments", s.args.length ? `<ol class="c-args" data-c="args">${s.args.map((a) => `<li><code class="c-cmd">${esc(a)}</code></li>`).join("")}</ol>` : `<span data-c="args">No arguments</span>`],
            ...(s.cwd ? [["Working folder", `<span class="mono" data-c="cwd">${esc(s.cwd)}</span>`]] : []),
          ]),
    ];
    return {
      title: name,
      back: go("installed"),
      body:
        facts(rowsList) +
        group("Gateway tool listing") +
        `<p class="c-line">For Pip's task "Errands", the most recent task of the bot you last opened.</p>` +
        lastRun +
        `<p class="c-line">A listing shows what the gateway has discovered for this task. A bot's tool rules still decide what it is offered.</p>` +
        group("Sign-in") +
        `<p class="c-state" data-c="signin">Not reported.</p>` +
        `<p class="c-line">The gateway doesn't report whether it's signed in to this server, or for whom. A bot's run shows whether its tools work.</p>` +
        (s.signin === "each" ? `<p class="c-line">Uses the gateway's requester sign-in. Set up and use it in a channel where the gateway identifies each sender. Clawtrate offers no sign-in for it.</p>` : "") +
        (s.signin === "oauth" && admin ? `<div class="c-actions">${link("Sign in", "signin-cli", { id: name, server: "1" })}</div>` : "") +
        (s.kind === "remote" && s.signin === "oauth"
          ? group("Accounts") +
            `<p class="c-line">A second name for the same server, with its own sign-in. Bots tell them apart by name.</p>` +
            (admin ? `<div class="c-actions">${link("Add another account", "add-server", { type: "remote", from: name })}</div>` : "")
          : "") +
        (iphone ? `<p class="c-line">Change it from Clawtrate on your computer.</p>` : admin ? `<div class="c-actions c-danger-actions">${link("Remove…", "server-remove-confirm", { id: name }, { variant: "quiet" })}</div>` : "") +
        accessBar("Changing tool servers needs admin access.") +
        granted(),
    };
  };

  // Adding a server (sections 12 and 13) -------------------------------------------------

  const addServerForm = () => {
    const type = params.get("type") || "remote";
    const from = params.get("from");
    const base = from ? serverOf(from) : null;
    const remote = type === "remote";
    const d = draft();
    const raw = d.type === type ? d.raw : {};
    const headerNames = base ? base.headers : raw.headerNames?.length ? raw.headerNames : [""];
    return {
      title: "Add a custom connector",
      body:
        (admin
          ? `<form class="c-form" id="c-server-form" novalidate data-type="${esc(type)}" data-from="${esc(from || "")}">` +
            `<fieldset class="c-type"><legend>Type</legend><div class="c-seg" role="radiogroup" aria-label="Type">` +
            `<a role="radio" aria-checked="${remote}" href="${esc(go("add-server", { type: "remote" }))}">Remote HTTPS</a>` +
            `<a role="radio" aria-checked="${!remote}" href="${esc(go("add-server", { type: "command" }))}">Command</a></div></fieldset>` +
            field("c-name", "Name", base ? "" : raw.name || "", "Letters, digits, hyphens and underscores. Bots see it in tool names.", "notes-work", params.get("conflict") ? `There's already a server named ${d.reviewed?.name || ""} on the gateway.` : "") +
            (remote
              ? field("c-url", "Server URL", base ? base.url : raw.url || "", "", "https://") +
                `<fieldset class="c-headers"><legend>Headers</legend><div id="c-header-rows">` +
                headerNames.map((h, i) => `<div class="c-header-row"><input class="input c-h-name" aria-label="Header name ${i + 1}" placeholder="Name" value="${esc(h)}" /><input class="input c-h-value" type="password" aria-label="Header value ${i + 1}" placeholder="Value" /></div>`).join("") +
                `</div><button type="button" class="button" data-variant="quiet" data-size="sm" id="c-add-header">Add a header</button>` +
                (base ? `<p class="c-line" data-c="values">Enter any header values this server needs. Saved values are hidden.</p>` : "") +
                `<p class="c-line">Kept by the gateway in its settings file, not encrypted there. Clawtrate can't read a value back once it's saved.</p></fieldset>` +
                `<fieldset class="c-signin"><legend>Sign-in</legend>` +
                radio("signin", "none", "None", base ? false : raw.signin !== "oauth") +
                radio("signin", "oauth", "Sign in with OAuth", base ? true : raw.signin === "oauth") +
                `<p class="c-line">OpenClaw registers itself with the server when it signs in.</p></fieldset>`
              : field("c-command", "Command", raw.command || "", "", "/path/to/server") +
                `<label class="c-field"><span>Arguments</span><textarea class="input" id="c-args" rows="3" aria-describedby="c-args-hint" placeholder="One per line">${esc(raw.args || "")}</textarea><span class="c-line" id="c-args-hint">One per line. Each line is one argument: spaces at its start and end are removed, spaces inside it stay, and an empty line is dropped. Nothing goes through a shell.</span></label>` +
                field("c-cwd", "Working folder", raw.cwd || "", "Optional.", "") +
                `<p class="c-line">The gateway can start this program on its own machine, as the user it runs as, when it needs this server. The program has that user's access to files, programs and the network.</p>` +
                `<p class="c-line">The gateway can show saved commands and arguments to operators who can read its settings.</p>`) +
            `<div class="c-actions"><button type="submit" class="button" id="c-submit" data-variant="primary" data-size="sm">${remote ? "Add to gateway" : "Continue"}</button></div>` +
            `</form>`
          : `<p class="c-line">Adding a custom connector writes the gateway's settings.</p>`) +
        accessBar("Adding a custom connector needs admin access.") +
        granted(),
    };
  };
  const field = (id, label, value, hint, placeholder, error = "") =>
    `<label class="c-field"><span>${label}</span><input class="input" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-describedby="${id}-error${hint ? ` ${id}-hint` : ""}"${error ? ' aria-invalid="true"' : ""} autocomplete="off" />` +
    `<span class="c-error" id="${id}-error" aria-live="polite">${esc(error)}</span>${hint ? `<span class="c-line" id="${id}-hint">${hint}</span>` : ""}</label>`;
  const radio = (nameAttr, value, label, checked) =>
    `<label class="c-radio"><input type="radio" name="${nameAttr}" value="${value}"${checked ? " checked" : ""} /><span>${label}</span></label>`;

  // Sign-in (section 10) ------------------------------------------------------------------

  const signinTarget = () => {
    const id = params.get("id") || "calendrop";
    const isServer = params.get("server") === "1";
    return isServer ? { name: id, host: "auth.notes.example", back: go("server", { id }), isServer } : { name: app(id).name, host: app(id).host || "auth.example", back: go("connector", { id }), isServer, id };
  };
  const signin = () => {
    const t = signinTarget();
    return {
      title: `Sign in to ${t.name}`,
      back: t.back,
      body: `<p class="c-text">The gateway starts this sign-in from its own command line or its own settings page.</p>` + cliSteps(t) + `<div class="c-actions"><a class="button" data-size="sm" href="${esc(t.back)}">Back to ${esc(t.name)}</a></div>`,
    };
  };
  // The gateway's command-line sign-in, in full (section 10).
  const cliSteps = (t) =>
    `<ol class="b-steps c-steps"><li><p>On the gateway's machine, run:</p>${command(`openclaw mcp login ${t.name}`, "sign-in command")}</li>` +
    `<li><p>If it prints an address, open it in a browser and sign in.</p></li>` +
    `<li><p>If the terminal is listening for the callback, it waits up to five minutes. Follow the terminal's instructions to finish with a code if the callback cannot reach it.</p></li>` +
    `<li><p>It may also find a saved sign-in and say so without printing an address.</p></li></ol>` +
    `<p class="c-line">Or sign in from Settings on the gateway's own web page.</p>` +
    `<p class="c-line">Afterwards this page still reads "Not reported": the gateway reports no sign-in state for an entry of its settings.</p>`;
  // A sign-in address, shown in full before it is opened: its host first, then the whole address.
  const address = (host) => {
    const full = `https://${host}/authorize?response_type=code&client_id=example-registered-client&state=example-state-7f3a`;
    return `<div class="c-address" aria-label="Sign-in address"><p class="c-address-host">${host}</p><p class="c-address-full mono">${esc(full)}</p>${copyButton("sign-in address", full)}</div>`;
  };

  // The conversation's connect card (section 11) -------------------------------------------

  // The card's words for each live result; `live` exists only in this page's memory.
  let live = null;
  const ordinaryCard = () =>
    `<p class="c-card-title">Used team-notes connect</p><p class="c-card-text mono" data-c="tool">team-notes__connect</p><p class="c-card-text">${esc('Connect MCP server "team-notes" at https://auth.teamnotes.example/authorize?state=example-state-2c41. After sign-in completes, the server\'s tools become available on the next message.')}</p>`;
  const liveCard = () => {
    const host = "auth.teamnotes.example";
    if (!live) return ordinaryCard();
    if (live.kind === "connected") return `<p class="c-card-title">Used team-notes connect</p><p class="c-card-text">${esc('MCP server "team-notes" is connected. Its tools become available on the next message.')}</p>`;
    if (live.kind === "error") return `<p class="c-card-title"><b>team-notes can't ask for a sign-in here:</b></p><p class="c-card-text mono">${esc('MCP server "team-notes" needs requester sign-in, but gateway.publicOrigin is not configured. Ask the operator to set the public Gateway HTTP(S) origin.')}</p>`;
    return (
      `<p class="c-card-title"><b>team-notes asks for a sign-in</b></p><p class="c-card-text">The gateway sees every device using Clawtrate as one sender, so this sign-in is shared by everyone who uses this gateway from Clawtrate.</p>` +
      address(host) +
      `<p class="c-line" id="c-copy-status" aria-live="polite"></p>` +
      `<p class="c-line">To sign in, copy this address into a browser.</p>` +
      `<p class="c-line">After you sign in, ask Pip again.</p>` +
      `<p class="c-line" data-tone="${live.shared ? "warn" : ""}">Anyone with this address can complete this shared sign-in.</p>`
    );
  };
  const chat = () =>
    `<div class="c-chat"><div class="c-chat-head"><span class="c-chat-title">Pip · Standup notes</span></div><div class="c-transcript">` +
    `<div class="c-bubble">Add today's standup to team-notes.</div>` +
    `<article class="c-card" id="c-card" aria-label="${params.get("card") === "history" ? "Tool call" : "Connect card"}">${initial("team-notes", "sm")}<div id="c-card-body">${params.get("card") === "history" ? ordinaryCard() : liveCard()}</div></article>` +
    `</div>` +
    proto("the bot's call returns, live, to this page", [
      `<button type="button" class="button" data-variant="quiet" data-size="sm" data-live="open">A sign-in page</button>`,
      `<button type="button" class="button" data-variant="quiet" data-size="sm" data-live="connected">Already connected</button>`,
      `<button type="button" class="button" data-variant="quiet" data-size="sm" data-live="error">No public address</button>`,
      `<button type="button" class="button" data-variant="quiet" data-size="sm" data-live="shared">In a shared task</button>`,
      link("Read from history", "chat", { card: "history" }, { variant: "quiet" }),
    ]) +
    `</div>`;

  // The picker (section 15) -----------------------------------------------------------------

  const picker = () =>
    `<div class="c-scrim"><div class="c-window c-picker" role="dialog" aria-modal="true" aria-labelledby="c-picker-title">` +
    `<div class="c-picker-body"><h2 id="c-picker-title">What do you use every day?</h2>` +
    `<p class="c-text">Pick the apps you use. Nothing is connected now; they come first in Connect apps.</p>` +
    search("Search apps") +
    `<ul class="c-tiles" id="c-tiles">${TILES.map((t) => `<li><label class="c-tile">${initial(t)}<span>${esc(t)}</span><input type="checkbox" value="${esc(t)}" /></label></li>`).join("")}</ul>` +
    `<div class="c-actions c-picker-actions"><a class="button" data-variant="quiet" data-size="sm" href="${go("home")}">Skip</a>` +
    `<a class="button" data-variant="primary" data-size="sm" id="c-next" href="${go("browse")}">Next</a></div>` +
    `</div></div></div>`;

  // Screens ------------------------------------------------------------------------------

  const A = () => app(params.get("id") || "quillnote");
  const SCREENS = {
    home: () => "",
    nav: () => windowHtml({ title: "Browse", body: browseLoaded(), pane: "nav" }),
    browse: () => windowHtml({ title: iphone ? "Plugins" : "Browse", body: browseLoaded() }),
    "browse-loading": () =>
      windowHtml({
        title: "Browse",
        body:
          search("Search across apps and skills") +
          `<div class="c-chips" aria-hidden="true"><span class="c-chip c-grey"></span><span class="c-chip c-grey"></span><span class="c-chip c-grey"></span></div>` +
          `<ul class="c-rows" aria-busy="true" aria-label="Loading the catalog">${"<li class=\"c-row c-grey-row\"></li>".repeat(4)}</ul>` +
          (params.get("slow") === "1" ? `<p class="c-line">Still loading. The gateway is asking the catalog.</p>` : "") +
          proto("the catalog", [link("Answers", "browse", {}, { variant: "quiet" }), link("Can't be reached", "browse-offline", {}, { variant: "quiet" }), link("4 s pass", "browse-loading", { slow: "1" }, { variant: "quiet" }), link("The gateway refuses", "browse-error", {}, { variant: "quiet" })]),
      }),
    "browse-offline": () => windowHtml({ title: "Browse", body: browseOffline() }),
    "browse-retry": () =>
      windowHtml({
        title: "Browse",
        body:
          `<p class="c-state" aria-busy="true">Asking the catalog… This can take up to 15 seconds.</p>` +
          proto("the catalog", [link("Answers", "browse", {}, { variant: "quiet" }), link("Still can't be reached", "browse-offline", {}, { variant: "quiet" })]),
      }),
    "browse-error": () => windowHtml({ title: "Browse", body: note("danger", "Couldn't load the catalog.", "Plugin discovery is unavailable: the gateway is shutting down.", `<div class="c-actions">${link("Try again", "browse-loading")}</div>`) }),
    "browse-category": () => {
      const cat = params.get("cat") || "productivity";
      const label = (CATEGORIES.find(([s]) => s === cat) || CATEGORIES[0])[1];
      return windowHtml({ title: "Browse", body: search("Search across apps and skills") + chips(cat) + group(label) + rows(APPS.filter((a) => a.cats.includes(cat))) + accessBar("Adding apps needs admin access.") });
    },
    app: () => {
      const a = A();
      return windowHtml({
        title: a.name,
        back: go("browse"),
        body:
          `<div class="c-hero">${initial(a.name, "lg")}<div><p class="c-hero-name">${esc(a.name)}</p><p class="c-faint">by ${esc(a.author)}${a.official ? " · Official" : ""}</p></div></div>` +
          `<p class="c-text">${esc(a.summary)}</p>` +
          group("What it adds") +
          `<ul class="c-list">${(a.servers || []).map(([s, o]) => `<li><span class="mono">${esc(s)}</span>, a tool server${o ? " that signs in with OAuth" : ""}</li>`).join("")}${(a.skills || []).map((k) => `<li>${esc(k)}, a skill</li>`).join("")}</ul>` +
          group("About") +
          `<p class="c-text c-readme">${esc(a.readme || a.summary).replace(/\n/g, "<br />")}</p>` +
          `<p class="c-faint">Version ${esc(a.version)}</p>` +
          (a.local === "unavailable" ? `<p class="c-line">Not available for this gateway's version.</p>` : "") +
          granted(),
        foot: a.local === "install" ? (admin ? link("Add", "add-confirm", { id: a.id }, { variant: "primary" }) : accessBar("Adding apps needs admin access.")) : "",
      });
    },
    "add-confirm": () => {
      const a = A();
      const official = a.official;
      return (
        windowHtml({ title: a.name, back: go("app", { id: a.id }), body: "" }) +
        confirm(
          `Add ${a.name} to the gateway?`,
          `<p>Package: <span class="mono">@${esc(a.author)}/${esc(a.id)}</span>, from ${official ? "the gateway's official catalog" : "ClawHub"}. ${official ? "The gateway picks the release from its catalog." : `Version ${esc(a.version)}, the release reviewed here.`}</p>` +
            `<p>The gateway installs this package and can run it with the gateway's access. The gateway will tell you if it needs a restart.</p>`,
          [link("Cancel", "app", { id: a.id }, { variant: "quiet", attrs: "data-autofocus" }), link("Add", params.get("ask") || "add-progress", { id: a.id }, { variant: "primary" })],
          proto("the gateway first asks for", [link("A review", "add-confirm", { id: a.id, ask: "add-consent" }, { variant: "quiet" }), link("An install warning", "add-confirm", { id: a.id, ask: "add-warning" }, { variant: "quiet" }), link("Nothing", "add-confirm", { id: a.id }, { variant: "quiet" })]),
        )
      );
    },
    "add-consent": () =>
      windowHtml({ title: A().name, back: go("app", { id: A().id }), body: "" }) +
      confirm(`${A().name} asks for more than the catalog listed.`, `<ul class="c-list"><li>A hook: <span class="mono">before_tool_call</span></li><li>A tool server: <span class="mono">quillnote-sync</span></li></ul>`, [link("Cancel", "app", { id: A().id }, { variant: "quiet" }), link("Add anyway", "add-progress", { id: A().id }, { variant: "primary" })]),
    "add-warning": () =>
      windowHtml({ title: A().name, back: go("app", { id: A().id }), body: "" }) +
      confirm("The gateway's install check found something.", `<ul class="c-list"><li><b>Warning:</b> Reads environment variables at startup. <span class="mono c-faint">dist/index.js, line 12</span></li></ul>`, [link("Cancel", "app", { id: A().id }, { variant: "quiet" }), link("Add anyway", "add-progress", { id: A().id }, { variant: "primary" })]),
    "add-progress": () =>
      windowHtml({
        title: `Adding ${A().name}`,
        body:
          steps([["Finding the release", "done"], ["Downloading", "done"], ["Unpacking", "done"], ["Writing files", "running"], ["Installing what it needs", "waiting"], ["Starting it on the gateway", "waiting"]]) +
          proto("the install ends", [
            link("Added", "add-done", { id: A().id }, { variant: "quiet" }),
            link("Needs a restart", "add-restart", { id: A().id }, { variant: "quiet" }),
            link("Refused", "add-refused", { id: A().id }, { variant: "quiet" }),
            link("Fails after writing", "add-partial", { id: A().id }, { variant: "quiet" }),
            link("No answer", "add-checking", { id: A().id }, { variant: "quiet" }),
          ]),
      }),
    "add-done": () => windowHtml({ title: `Adding ${A().name}`, body: result("ok", "check", `Added ${A().name}.`, "The gateway lists it as installed and turned on.", link(`Open ${A().name}`, "connector", { id: A().id, auth: "unauthenticated" }, { variant: "primary" })) }),
    "add-restart": () => windowHtml({ title: `Adding ${A().name}`, body: result("", "warning", `Added ${A().name}.`, esc(`The gateway says it needs a restart before ${A().name} works. Clawtrate doesn't restart the gateway.`)) }),
    "add-refused": () => windowHtml({ title: `Adding ${A().name}`, body: result("danger", "x", `Couldn't add ${A().name}:`, esc(`${A().refusal || "fetch failed"}. The gateway lists nothing new.`), link("Try again", "add-confirm", { id: A().id })) }),
    "add-partial": () => windowHtml({ title: `Adding ${A().name}`, body: result("danger", "warning", `${A().name} was installed but didn't start:`, esc("quillnote: the module could not be loaded."), link(`Open ${A().name}`, "connector", { id: "boxwharf" })) }),
    "add-checking": () =>
      windowHtml({
        title: `Adding ${A().name}`,
        body: `<p class="c-state" aria-busy="true">Checking what the gateway has…</p>` + proto("the read-back", [link("Lists it", "add-done", { id: A().id }, { variant: "quiet" }), link("Doesn't list it", "add-refused", { id: A().id }, { variant: "quiet" })]),
      }),
    installed: () =>
      windowHtml({
        title: "On this gateway",
        body:
          readonlyNote() +
          search("Search what's on this gateway") +
          group("Turned on") +
          rows(APPS.filter((a) => !a.bundled && ["enabled", "error"].includes(a.local)), "connector") +
          group("Turned off") +
          rows(APPS.filter((a) => !a.bundled && ["disabled", "needs-setup"].includes(a.local)), "connector") +
          `<details class="c-fold"><summary>Comes with OpenClaw (${APPS.filter((a) => a.bundled).length})</summary>${rows(APPS.filter((a) => a.bundled), "connector")}</details>` +
          group("Tool servers") +
          `<ul class="c-rows">${Object.entries(SERVERS).map(([n, s]) => `<li class="c-row"><a class="c-row-main" href="${esc(go("server", { id: n }))}" aria-label="${esc(n)}, ${s.kind === "remote" ? "added by address" : "runs a command"}">${initial(n)}<span class="c-row-text"><span class="c-row-name mono">${esc(n)}</span><span class="c-row-sub">${esc(s.kind === "remote" ? `Added by address · ${s.url}` : `Runs a command · ${s.command}`)}</span></span></a></li>`).join("")}</ul>` +
          (admin ? `<div class="c-actions">${link("Add a custom connector", "add-server")}</div>` : ""),
      }),
    connector: () => windowHtml(connectorPage()),
    "turnoff-confirm": () => {
      const a = app(params.get("id"));
      return (
        windowHtml(connectorPage()) +
        confirm(
          `Turn off ${a.name}?`,
          `<p>The gateway stops offering its tools. Its settings and any saved sign-ins stay.</p>`,
          [link("Cancel", "connector", { id: a.id }, { variant: "quiet" }), link("Turn off", "connector", params.get("busy") ? { id: a.id, busy: "1" } : { id: a.id, now: "off", said: "off" }, { variant: "primary" })],
          proto("the gateway is", [link("Busy with another change", "turnoff-confirm", { id: a.id, busy: "1" }, { variant: "quiet" })]),
        )
      );
    },
    "remove-confirm": () => {
      const a = app(params.get("id") || "tasktide");
      return (
        windowHtml(connectorPage()) +
        confirm(
          `Remove ${a.name} from the gateway?`,
          `<p data-c="package">The package <span class="mono">@${esc(a.author)}/${esc(a.id)}</span>, with: ${esc(a.name)}, ${esc(a.name)} sync.</p>` +
            goes(["the package's files on the gateway's machine", "its settings on the gateway", "its tools"], ["any saved sign-ins, kept by the gateway in its state, not encrypted there", `a note on the gateway that ${a.name} is off, so nothing turns it back on by itself`]),
          [link("Cancel", "connector", { id: a.id }, { variant: "quiet" }), link("Remove", "removed", { id: a.id }, { variant: "primary" })],
          proto("the read-back", [link("The read fails", "removed-unconfirmed", { id: a.id }, { variant: "quiet" })]),
        )
      );
    },
    removed: () => {
      const a = app(params.get("id") || "tasktide");
      return windowHtml({ title: a.name, back: go("installed"), body: result("", "check", `Removed ${a.name}.`, esc(`No longer installed: ${a.name}, ${a.name} sync. The gateway's list shows each with installed: false.`)) + goes(["the package's files", "its settings", "its tools"], ["any saved sign-ins, kept by the gateway in its state, not encrypted there", "the note that it is off"], "done") + `<div class="c-actions">${link("Back to the list", "installed")}</div>` });
    },
    "removed-unconfirmed": () => {
      const a = app(params.get("id") || "tasktide");
      return windowHtml({ title: a.name, back: go("connector", { id: a.id }), body: note("warn", "Couldn't confirm the removal.", "The gateway's plugin list couldn't be read.", `<div class="c-actions">${link("Check again", "removed", { id: a.id })}</div>`) });
    },
    server: () => windowHtml(serverPage()),
    "server-remove-confirm": () => {
      const name = params.get("id") || "notes-work";
      const s = serverOf(name);
      return (
        windowHtml(serverPage()) +
        confirm(
          `Remove ${name} from the gateway?`,
          goes([`the server's entry in the gateway's settings${s.kind === "remote" ? ", with its headers" : ""}`, "its tools"], [s.signin ? "Removing this entry leaves any saved sign-ins in the gateway's state. The gateway keeps them unencrypted. The gateway finds them again if a server with the same name and URL is added." : "nothing else: an entry without OAuth has no sign-in the gateway keeps"]) +
            (s.signin === "oauth" ? `<p>To clear them, run this on the gateway's machine before removing the entry:</p>${command(`openclaw mcp logout ${name}`, "sign-out command")}<p>or remove it there with this, which clears them too:</p>${command(`openclaw mcp unset ${name}`, "removal command")}` : "") +
            (s.signin === "each" ? `<p>To remove it and clear them, run this on the gateway's machine instead:</p>${command(`openclaw mcp unset ${name}`, "removal command")}` : ""),
          [link("Cancel", "server", { id: name }, { variant: "quiet" }), `<a class="button" data-variant="primary" data-size="sm" href="${esc(go("write-sent", { op: "remove" }))}" data-remove="${esc(name)}">Remove</a>`],
        )
      );
    },
    "add-server": () => windowHtml(addServerForm()),
    "command-confirm": () => {
      const r = draft().reviewed || { name: "", command: "", args: [], cwd: "" };
      return (
        windowHtml(addServerForm()) +
        confirm(
          "Run this command on the gateway's machine?",
          `<p>On Home gateway's machine (<span class="mono">studio.example</span>):</p>` +
            `<dl class="c-cmd-facts"><div><dt>Program</dt><dd><code class="c-cmd" data-c="program">${esc(r.command)}</code></dd></div>` +
            `<div><dt>Arguments</dt><dd>${r.args.length ? `<ol class="c-args" data-c="args">${r.args.map((a) => `<li><code class="c-cmd">${esc(a)}</code></li>`).join("")}</ol>` : `<span data-c="args">No arguments</span>`}</dd></div>` +
            (r.cwd ? `<div><dt>Working folder</dt><dd><code class="c-cmd" data-c="cwd">${esc(r.cwd)}</code></dd></div>` : "") +
            `</dl>` +
            `<p>The gateway can start this program on its own machine, as the user it runs as, when it needs this server. The program has that user's access to files, programs and the network.</p>`,
          [link("Cancel", "add-server", { type: "command", focus: "c-submit" }, { variant: "quiet" }), link("Add command server", "write-sent", { op: "add" }, { variant: "primary" })],
        )
      );
    },
    // A server write (section 12): sent with the reviewed hash, then the gateway's reply, then a fresh read.
    "write-sent": () => {
      const op = params.get("op") || "add";
      const name = (op === "remove" ? store.get("removing") : draft().reviewed?.name) || "notes-work";
      return windowHtml({
        title: op === "remove" ? name : "Add a custom connector",
        body:
          `<p class="c-state" aria-busy="true" data-c="checking">Checking what the gateway has…</p>` +
          proto("the gateway's reply", [
            link("Accepted", "write-read", { op, reply: "accepted" }, { variant: "quiet" }),
            link("Refused", "write-read", { op, reply: "refused" }, { variant: "quiet" }),
            link("No reply", "write-read", { op, reply: "lost" }, { variant: "quiet" }),
            link("Settings changed", "write-read", { op, reply: "stale" }, { variant: "quiet" }),
          ]),
      });
    },
    "write-read": () => {
      const op = params.get("op") || "add";
      const reply = params.get("reply") || "accepted";
      const name = (op === "remove" ? store.get("removing") : draft().reviewed?.name) || "notes-work";
      const choices =
        op === "remove"
          ? [["No such entry", "absent"], ["Still has it", "present"], ["Read failed", "failed"]]
          : reply === "stale"
            ? [["The name now exists", "taken"], ["Has no such entry", "absent"], ["Read failed", "failed"]]
            : [["Matches every reviewed field", "match"], ["Has no such entry", "absent"], ["Has a different entry", "differs"], ["Read failed", "failed"]];
      return windowHtml({
        title: op === "remove" ? name : "Add a custom connector",
        body: `<p class="c-state" aria-busy="true" data-c="checking">Checking what the gateway has…</p>` + proto("the fresh read", choices.map(([label, read]) => link(label, "write-result", { op, reply, read }, { variant: "quiet" }))),
      });
    },
    "write-result": () => {
      const op = params.get("op") || "add";
      const reply = params.get("reply") || "accepted";
      const read = params.get("read") || "match";
      const again = `<div class="c-actions">${link("Check again", "write-read", { op, reply })}</div>`;
      const readFailed = note("warn", "Couldn't confirm the change.", "The gateway's settings couldn't be read back.", again);
      const changed = note("warn", "The gateway's settings changed.", "Review the current entry before trying again.");
      if (op === "remove") {
        const name = store.get("removing") || "notes-work";
        if (reply === "stale")
          return windowHtml({ title: name, back: go("server", { id: name }), body: changed + `<div class="c-actions">${link(`Review ${name}`, "server", { id: name })}</div>` });
        const body =
          read === "absent"
            ? result("", "check", `Removed ${name}.`, "The gateway's settings no longer have it.") + `<div class="c-actions">${link("Back to the list", "installed")}</div>`
            : read === "present"
              ? note("danger", `${name} is still in the gateway's settings.`, reply === "refused" ? "Another plugin or config operation is already running; retry when it completes." : "", `<div class="c-actions">${link(`Review ${name}`, "server", { id: name })}</div>`)
              : readFailed;
        if (read === "absent") {
          const all = saved();
          delete all[name];
          store.set("saved", all);
        }
        return windowHtml({ title: name, back: go("installed"), body });
      }
      const r = draft().reviewed || { kind: "remote", name: "notes-home", url: "https://notes.example/mcp", headers: [], signin: "none" };
      const name = r.name;
      const fields = (e) =>
        facts(
          e.kind === "command"
            ? [["Program", `<span class="mono">${esc(e.command)}</span>`], ["Arguments", e.args.length ? esc(e.args.join(", ")) : "No arguments"], ...(e.cwd ? [["Working folder", `<span class="mono">${esc(e.cwd)}</span>`]] : [])]
            : [["Address", `<span class="mono">${esc(e.url)}</span>`], ["Headers", e.headers?.length ? esc(e.headers.join(", ")) : "None"], ["Sign-in", e.signin === "oauth" ? "Signs in with OAuth" : "None"]],
        );
      let body;
      if (reply === "stale") {
        body =
          read === "taken"
            ? changed + note("danger", `There's already a server named ${name} on the gateway.`, "Choose another name before adding. This is the gateway's current entry:") + fields({ kind: "remote", url: "https://notes-other.example/mcp", headers: ["Authorization"], signin: "none" }) + `<div class="c-actions">${link("Back to the form", "add-server", { type: r.kind, conflict: "1" })}</div>`
            : read === "failed"
              ? changed + readFailed
              : changed + `<div class="c-actions">${link("Back to the form", "add-server", { type: r.kind })}</div>`;
      } else if (read === "failed") {
        body = readFailed;
      } else if (read === "differs") {
        body = note("warn", "Couldn't confirm the change.", "The gateway lists a different entry.") + fields({ ...r, url: "https://notes-other.example/mcp", headers: ["Authorization"] }) + again;
      } else if (read === "match" && reply !== "accepted") {
        body = note("warn", "The gateway lists an entry with these settings.", "Couldn't confirm this save.") + fields(r) + again;
      } else if (read === "match") {
        if (!SERVERS[name]) store.set("saved", { ...saved(), [name]: r });
        body =
          result("ok", "check", `Added ${name}.`, esc(r.kind === "command" ? "The gateway lists this server. The gateway can start this program when it needs this server." : `The gateway lists this server.${r.headers?.length ? " The gateway hides saved header values." : ""}`), link(`Open ${name}`, "server", { id: name }, { variant: "primary" }) + (r.signin === "oauth" ? link("Sign in", "signin-cli", { id: name, server: "1" }) : ""));
      } else {
        body =
          reply === "refused"
            ? result("danger", "x", `Couldn't add ${name}:`, esc(`mcp.servers.${name}.url: Expected http:// or https:// URL`), link("Back to the form", "add-server", { type: r.kind }))
            : result("danger", "x", `${name} wasn't added.`, esc(`The gateway's settings have no entry named ${name}.`), link("Back to the form", "add-server", { type: r.kind }));
      }
      return windowHtml({ title: "Add a custom connector", body });
    },
    "signin-cli": () => windowHtml(signin()),
    chat: () => "",
    picker: () => picker(),
  };
  const ANNOUNCE = {
    browse: `${APPS.length} apps`,
    "browse-loading": "Loading the catalog",
    "browse-offline": "Showing what's on this gateway",
    "add-progress": `Adding ${A().name}`,
    "add-done": `Added ${A().name}`,
    "add-refused": `Couldn't add ${A().name}`,
    removed: `Removed ${app(params.get("id") || "tasktide").name}`,
  };

  // The app behind the window: the rail with its footer, as visual-language.md §7 has it.
  const shell = () =>
    `<div class="c-shell"><aside class="c-rail" aria-label="Bots">` +
    `<ul class="c-bots">${["juniper", "otto", "marlow", "pip"].map((b) => `<li><span class="avatar">${CT.character(b)}</span><span>${b[0].toUpperCase() + b.slice(1)}</span></li>`).join("")}</ul>` +
    `<div class="c-rail-foot"><a class="button c-connect-apps" data-size="sm" href="${go("browse")}">${icon("plug")}Connect apps</a>` +
    `<p class="c-gateway"><span class="c-dot"></span>Home gateway</p></div></aside>` +
    `<main class="c-main">${screen === "chat" ? chat() : `<p class="c-empty">Open Connect apps from the foot of the rail.</p>` + (screen === "home" ? proto("first run", [link("What do you use every day?", "picker", {}, { variant: "quiet" }), link("A connect card", "chat", {}, { variant: "quiet" })]) : "")}</main></div>`;

  const root = document.getElementById("c-root");
  const render = SCREENS[screen] || SCREENS.home;
  root.innerHTML = shell() + render();
  document.getElementById("c-live").textContent = ANNOUNCE[screen] || (params.get("said") === "on" ? `Turned on ${app(params.get("id")).name}` : params.get("said") === "off" ? `Turned off ${app(params.get("id")).name}` : req === "granted" ? "Admin access granted" : req === "asking" ? "Asking the gateway" : "");

  // Focus: a confirmation's Cancel, else the section's title.
  const autofocus = root.querySelector(".c-confirm .c-actions .button[data-variant='quiet']") || root.querySelector("#c-section-title") || root.querySelector("#c-picker-title");
  if (autofocus) autofocus.focus({ preventScroll: true });

  // Focus a named control when the address asks (a dialog that closed returns focus to its trigger).
  if (params.get("focus")) document.getElementById(params.get("focus"))?.focus();

  // Tab and Shift-Tab stay inside the top-most dialog.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const top = root.querySelector(".c-confirm") || root.querySelector(".c-window");
    if (!top) return;
    const items = [...top.querySelectorAll("a[href], button:not([disabled]), input, textarea, select, [tabindex='0']")].filter((el) => el.offsetParent !== null && el.tabIndex !== -1);
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!top.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // The category chips: one tab stop; Left and Right move and choose, Home and End go to the ends.
  root.querySelector(".c-chips[role=radiogroup]")?.addEventListener("keydown", (event) => {
    const chipsList = [...root.querySelectorAll(".c-chips .c-chip")];
    const at = chipsList.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: chipsList.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = chipsList[(to + chipsList.length) % chipsList.length];
    location.href = `${next.getAttribute("href")}&focus=chip-${next.dataset.slug || "all"}`;
  });

  // Escape closes the top-most surface.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const cancel = root.querySelector(".c-confirm .c-actions .button[data-variant='quiet']");
    if (cancel) location.href = cancel.href;
    else if (root.querySelector(".c-window")) location.href = go("home");
  });

  // Search: filters the rows as it is typed; on Browse it also searches skills.
  const q = document.getElementById("c-q");
  if (q && screen !== "picker") {
    const results = document.getElementById("c-results");
    const original = results ? results.innerHTML : "";
    const offline = screen === "browse-offline";
    q.addEventListener("input", () => {
      const text = q.value.trim().toLowerCase();
      if (!results) return;
      if (!text) {
        results.innerHTML = original;
        root.querySelector(".c-chips")?.removeAttribute("hidden");
        return;
      }
      root.querySelector(".c-chips")?.setAttribute("hidden", "");
      const pool = offline ? APPS.filter((a) => a.local !== "install" && a.local !== "unavailable") : APPS;
      const apps = pool.filter((a) => `${a.name} ${a.summary}`.toLowerCase().includes(text));
      const skillsFailed = params.get("skills") === "fail";
      const skills = offline || skillsFailed ? [] : SKILLS.filter((s) => `${s.name} ${s.text}`.toLowerCase().includes(text));
      results.innerHTML =
        !apps.length && !skills.length && !offline && !skillsFailed
          ? `<p class="c-state" data-c="none">No apps or skills match "${esc(q.value.trim())}".</p>`
          : group(offline ? "On this gateway" : "Apps") +
            (offline ? `<p class="c-line">The catalog didn't answer this search.</p>` : "") +
            (apps.length ? rows(apps, offline ? "connector" : "app") : `<p class="c-line">No apps match.</p>`) +
            group("Skills") +
            (offline ? `<p class="c-line">Searching skills needs the catalog.</p>` : skillsFailed ? `<p class="c-line">Skills search didn't answer.</p>` : skills.length ? `<ul class="c-rows">${skills.map((s) => `<li class="c-row"><span class="c-row-main">${initial(s.name)}<span class="c-row-text"><span class="c-row-name">${esc(s.name)}</span><span class="c-row-sub">${esc(s.text)}</span></span></span></li>`).join("")}</ul>` : `<p class="c-line">No skills match.</p>`);
      document.getElementById("c-live").textContent = apps.length || skills.length ? `${apps.length} apps, ${skills.length} skills` : "No apps match";
    });
  }

  // The picker: ticks are kept on this device; Next carries them to Browse.
  const tiles = document.getElementById("c-tiles");
  if (tiles) {
    const next = document.getElementById("c-next");
    const update = () => {
      const chosen = [...tiles.querySelectorAll("input:checked")].map((i) => i.value);
      next.href = go("browse", chosen.length ? { picked: chosen.join(",") } : {});
    };
    tiles.addEventListener("change", update);
    q?.addEventListener("input", () => {
      const text = q.value.trim().toLowerCase();
      tiles.querySelectorAll("li").forEach((li) => (li.hidden = !li.textContent.toLowerCase().includes(text)));
    });
  }

  // The tool server form: Clawtrate's own checks, then the gateway's answer (sections 12, 13).
  const form = document.getElementById("c-server-form");
  if (form) {
    document.getElementById("c-add-header")?.addEventListener("click", () => {
      const rowsBox = document.getElementById("c-header-rows");
      const n = rowsBox.children.length + 1;
      rowsBox.insertAdjacentHTML("beforeend", `<div class="c-header-row"><input class="input c-h-name" aria-label="Header name ${n}" placeholder="Name" /><input class="input c-h-value" type="password" aria-label="Header value ${n}" placeholder="Value" /></div>`);
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const errors = [];
      const set = (id, message) => {
        const input = document.getElementById(id);
        document.getElementById(`${id}-error`).textContent = message;
        input.setAttribute("aria-invalid", message ? "true" : "false");
        if (message) errors.push(input);
      };
      const rawName = document.getElementById("c-name").value;
      const name = rawName.trim();
      set("c-name", !name ? "Enter a name." : !/^[A-Za-z0-9_-]+$/.test(name) ? "Use letters, digits, hyphens and underscores." : known(name) || (params.get("conflict") && name === draft().reviewed?.name) ? `There's already a server named ${name}.` : "");
      if (form.dataset.type === "remote") {
        const rawUrl = document.getElementById("c-url").value;
        const url = rawUrl.trim();
        let parsed = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        set("c-url", !url ? "Enter the server's URL." : !parsed || !/^https?:$/.test(parsed.protocol) ? "Enter a URL that starts with https://." : parsed.protocol !== "https:" ? "Use the server's https:// URL." : "");
        if (errors.length) return errors[0].focus();
        const headerNames = [...form.querySelectorAll(".c-h-name")].map((i) => i.value.trim()).filter(Boolean);
        const signin = form.querySelector("input[name='signin']:checked").value;
        store.set("draft", { type: "remote", raw: { name: rawName, url: rawUrl, headerNames, signin }, reviewed: { kind: "remote", name, url, headers: headerNames, signin } });
        location.href = go("write-sent", { op: "add" });
      } else {
        const rawCommand = document.getElementById("c-command").value;
        const rawArgs = document.getElementById("c-args").value;
        const rawCwd = document.getElementById("c-cwd").value;
        const cmd = rawCommand.trim();
        set("c-command", cmd ? "" : "Enter the command.");
        if (errors.length) return errors[0].focus();
        // Each line is one argument, trimmed at its ends; empty lines are dropped.
        const args = rawArgs.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
        const cwd = rawCwd.trim();
        store.set("draft", { type: "command", raw: { name: rawName, command: rawCommand, args: rawArgs, cwd: rawCwd }, reviewed: { kind: "command", name, command: cmd, args, ...(cwd ? { cwd } : {}) } });
        location.href = go("command-confirm", { type: "command" });
      }
    });
  }

  root.querySelector("[data-remove]")?.addEventListener("click", (event) => store.set("removing", event.currentTarget.dataset.remove));

  // A live tool result arrives: the card is drawn from it, in this page only.
  root.addEventListener("click", (event) => {
    const trigger = event.target.closest("[data-live]");
    if (!trigger) return;
    const kind = trigger.dataset.live;
    live = { kind: kind === "shared" ? "open" : kind, shared: kind === "shared" };
    document.getElementById("c-card").setAttribute("aria-label", "Connect card");
    document.getElementById("c-card-body").innerHTML = liveCard();
  });

  // Copy buttons: "Copied" only once the clipboard write resolves, as conversation.md §9 has it.
  root.addEventListener("click", (event) => {
    const button = event.target.closest(".copy");
    if (!button) return;
    const what = button.getAttribute("aria-label").replace(/^Copy /, "");
    const status = document.getElementById("c-copy-status");
    const say = (words) => {
      document.getElementById("c-live").textContent = words;
      if (status) status.textContent = words;
    };
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(button.dataset.copy))
      .then(
        () => {
          button.dataset.copied = "true";
          say(`Copied ${what}`);
          setTimeout(() => delete button.dataset.copied, 1400);
        },
        () => say(`Couldn't copy the ${what}.`),
      );
  });
})();
