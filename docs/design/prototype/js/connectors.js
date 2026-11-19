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
  const KEEP = ["theme", "width", "motion", "chrome", "access", "picked", "device", "app"];
  // The web preview (?app=preview) is a browser: only there is the browser sign-in offered (section 10).
  const preview = params.get("app") === "preview";
  // On the iPhone the window is "Plugins" (F-380), with its own words.
  const iphone = params.get("device") === "iphone";
  const go = (to, extra = {}) => {
    const next = new URLSearchParams([...params].filter(([k]) => KEEP.includes(k)));
    next.set("screen", to);
    for (const [key, value] of Object.entries(extra)) if (value !== null) next.set(key, value);
    return `connectors.html?${next}`;
  };
  const admin = access === "admin" || req === "granted";

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
    { id: "chartwick", name: "Chartwick", summary: "Dashboards and charts from your sheets.", author: "chartwick", cats: ["productivity"], version: "0.8.0", local: "install", servers: [["chartwick", false]] },
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
    "notes-work": { kind: "remote", url: "https://notes.example/mcp", headers: ["Authorization"], signin: "oauth", last: "tools" },
    "search-index": { kind: "command", command: "/opt/example/bin/search-server", args: ["--stdio", "--index", "./notes"], last: "unavailable" },
    "team-notes": { kind: "remote", url: "https://teamnotes.example/mcp", headers: [], signin: "each", last: "notyet" },
  };
  const app = (id) => APPS.find((a) => a.id === id) || APPS[0];
  const picked = (params.get("picked") || "").split(",").filter(Boolean);

  // Pieces -----------------------------------------------------------------------------

  const initial = (name, size = "") => `<span class="c-initial"${size ? ` data-size="${size}"` : ""} aria-hidden="true">${esc(name[0])}</span>`;
  const link = (label, to, extra = {}, { variant, size = "sm", attrs = "" } = {}) =>
    `<a class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}" href="${go(to, extra)}"${attrs ? ` ${attrs}` : ""}>${label}</a>`;
  const pill = (text, tone = "") => `<span class="c-pill"${tone ? ` data-tone="${tone}"` : ""}>${text}</span>`;
  const note = (tone, lead, text, extra = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="${tone === "danger" ? "alert" : "status"}">` +
    `${icon(tone ? "warning" : "clock")}<div><p>${lead ? `<b>${lead}</b>` : ""}${lead && text ? " " : ""}${text}</p>${extra}</div></div>`;
  const group = (text) => `<h4 class="b-group">${text}</h4>`;
  const facts = (rows) => `<dl class="facts c-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const copyButton = (label, text) =>
    `<button type="button" class="copy" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const command = (text, label) => `<div class="command-line"><code>${esc(text)}</code>${copyButton(label, text)}</div>`;
  const result = (tone, mark, title, text, actions = "") =>
    `<div class="b-result c-result"><span class="empty-mark"${tone ? ` data-tone="${tone}"` : ""}>${icon(mark)}</span>` +
    `<h3>${title}</h3><p>${text}</p>${actions ? `<div class="b-actions c-actions">${actions}</div>` : ""}</div>`;
  const proto = (label, buttons) =>
    `<div class="c-proto" role="group" aria-label="Prototype"><span>Prototype: ${label}</span>${buttons.join("")}</div>`;
  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(([text, state]) => {
        const mark = state === "done" ? icon("check") : state === "failed" ? icon("x") : "";
        return `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${state}"><span class="s-step-mark">${mark}</span><span>${text}</span><span class="s-step-time"></span></li>`;
      })
      .join("") +
    `</ol>`;
  const goes = (gone, stays, read = null) =>
    `<div class="c-goes"><h4>Goes</h4><ul>${gone.map((t) => `<li data-mark="${read ? read : "goes"}">${icon(read ? "check" : "x")}<span>${t}</span></li>`).join("")}</ul>` +
    `<h4>Stays</h4><ul>${stays.map((t) => `<li data-mark="stays">${icon("check")}<span>${t}</span></li>`).join("")}</ul></div>`;

  // The access bar of bots.md §2, in an admin action's place.
  const accessBar = (what) => {
    if (admin) return "";
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
    if (a.local === "install") return admin ? link("Add", "add-confirm", { id: a.id }, { attrs: `aria-label="Add ${a.name}"` }) : "";
    if (a.local === "unavailable") return `<span class="c-faint">Not available</span>`;
    return statePill(a);
  };
  const statePill = (a) =>
    ({ enabled: pill("Added"), disabled: pill("Turned off"), "needs-setup": pill("Needs setup", "warn"), error: pill("Not working", "danger") })[a.local] || "";
  const row = (a, to = "app") => {
    const state = a.local === "install" ? "Add" : a.local === "unavailable" ? "Not available" : { enabled: "Added", disabled: "Turned off", "needs-setup": "Needs setup", error: "Not working" }[a.local];
    return (
      `<li class="c-row" data-app="${a.id}"><a class="c-row-main" href="${go(a.local === "install" || a.local === "unavailable" ? "app" : to, { id: a.id })}" aria-label="${esc(`${a.name}, ${state}, ${a.summary}`)}">` +
      `${initial(a.name)}<span class="c-row-text"><span class="c-row-name">${a.name}</span><span class="c-row-sub">${a.bundled ? "Comes with OpenClaw · " : ""}${a.summary}</span></span></a>` +
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
    s.startsWith("browse") || s.startsWith("app") || s.startsWith("add-") && !s.startsWith("add-server") ? "browse" : s.startsWith("add-server") || s === "command-confirm" ? "add-server" : "installed";
  const windowHtml = ({ title, body, back, foot = "", pane = "section", label }) => {
    const current = navOf(screen);
    return (
      `<div class="c-scrim"><div class="c-window" role="dialog" aria-modal="true" aria-labelledby="c-window-title">` +
      `<h2 class="visually-hidden" id="c-window-title">${label || (iphone ? "Plugins" : "Connect apps")}</h2>` +
      `<div class="c-frame" data-pane="${pane}">` +
      `<nav class="c-nav" aria-label="Connect apps"><div class="c-nav-head"><p class="c-nav-title">${label || (iphone ? "Plugins" : "Connect apps")}</p>` +
      `<a class="icon-button c-close" href="${go("home")}" aria-label="Close">${icon("x")}</a></div>` +
      NAV.filter(([id]) => !(iphone && id === "add-server")).map(([id, text]) => `<a class="c-nav-item" href="${go(id)}"${id === current ? ' aria-current="page"' : ""}>${text}${icon("chevron")}</a>`).join("") +
      `</nav>` +
      `<section class="c-section" aria-labelledby="c-section-title">` +
      `<div class="c-section-head">${back ? `<a class="icon-button c-back" href="${back}" aria-label="Back">${icon("back")}</a>` : `<a class="icon-button c-back c-to-nav" href="${go("nav")}" aria-label="Back">${icon("back")}</a>`}` +
      `<h3 id="c-section-title" tabindex="-1">${title}</h3><a class="icon-button c-close" href="${go("home")}" aria-label="Close">${icon("x")}</a></div>` +
      `<div class="c-section-body">${body}</div>${foot ? `<div class="c-section-foot">${foot}</div>` : ""}` +
      `</section></div></div></div>`
    );
  };
  const confirm = (title, text, buttons, extra = "") =>
    `<div class="c-scrim c-scrim-top"><div class="c-confirm" role="alertdialog" aria-modal="true" aria-labelledby="c-confirm-title" aria-describedby="c-confirm-text">` +
    `<h2 id="c-confirm-title">${title}</h2><div id="c-confirm-text">${text}</div>${extra}<div class="b-actions c-actions">${buttons.join("")}</div></div></div>`;

  // Browse (sections 4 and 5) -------------------------------------------------------------

  const search = (placeholder, value = "") =>
    `<div class="c-search" role="search"><span class="c-search-icon">${icon("search")}</span>` +
    `<input class="input" type="search" id="c-q" aria-label="${placeholder}" placeholder="${placeholder}" value="${esc(value)}" autocomplete="off" /></div>`;
  const chips = (chosen) =>
    `<div class="c-chips" role="radiogroup" aria-label="Categories">` +
    [["", "All"], ...CATEGORIES]
      .map(([slug, label]) => `<a class="c-chip" role="radio" aria-checked="${chosen === slug}" tabindex="${chosen === slug ? 0 : -1}" href="${go(slug ? "browse-category" : "browse", slug ? { cat: slug } : {})}">${label}</a>`)
      .join("") +
    `</div>`;
  const browseLoaded = () => {
    const pickedRows = APPS.filter((a) => picked.includes(a.name));
    return (
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
    if (a.local === "needs-setup") return [`Needs setup: the gateway needs ${a.missing.join(", ")} before it can turn ${a.name} on. Change these in the gateway's own settings page.`, []];
    if (a.local === "error") return [`Not working: ${esc(a.error)}`, [admin ? link("Turn off", "turnoff-confirm", { id: a.id }) : ""]];
    if (a.bundled) return ["Added. Not loaded yet: it loads when a bot first needs it.", [admin ? link("Turn off", "turnoff-confirm", { id: a.id }) : ""]];
    return ["Added", [admin ? link("Turn off", "turnoff-confirm", { id: a.id }) : ""]];
  };
  const accountRow = (a) => {
    const off = params.get("now") === "off" || (a.local === "disabled" && params.get("now") !== "on");
    if (!a.servers || !a.servers.some(([, oauth]) => oauth)) return "";
    if (off) return group("Accounts") + `<p class="c-line">The gateway reports sign-ins only while ${a.name} is turned on.</p>`;
    const state = params.get("auth") || a.auth || "unauthenticated";
    const words = {
      unauthenticated: [pill("Needs sign-in", "warn"), "Sign in"],
      "requires-authorization": [`${pill("Needs sign-in again", "warn")} <span>The server asked for more access.</span>`, "Sign in"],
      "pending-authorization": [`<span>A sign-in was started and didn't finish.</span>`, "Sign in"],
      authorized: [`<span><b>Signed in.</b> The gateway holds this sign-in until Dec 17, 5:12 PM.</span><span class="c-faint">Whether it still works shows when a bot next uses ${a.name}.</span>`, "Sign in again"],
    }[state];
    return (
      group("Accounts") +
      `<ul class="c-rows"><li class="c-account"><span class="c-row-text"><span class="c-row-name">Shared by everyone on this gateway</span><span class="c-row-sub c-account-state">${words[0]}</span></span>` +
      `<span class="c-row-end">${admin ? link(words[1], preview ? "signin-starting" : "signin-cli", { id: a.id }, { variant: state === "authorized" ? "quiet" : "" }) : ""}</span></li></ul>`
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
        (params.get("busy") === "1" ? note("warn", "The gateway is busy with another change.", "Try again in a moment.", `<div class="c-actions">${link("Try again", "turnoff-confirm", { id: a.id })}</div>`) : "") +
        (said === "on" ? note("", `Turned on ${a.name}.`, `The gateway lists it as added.`) : said === "off" ? note("", `Turned off ${a.name}.`, "The gateway lists it as turned off.") : "") +
        `<div class="c-hero">${initial(a.name, "lg")}<div><p class="c-hero-name">${a.name}</p><p class="c-faint">${a.bundled ? "Comes with OpenClaw" : `by ${a.author}`} · ${a.version}</p></div></div>` +
        `<p class="c-state" data-c="state">${state}</p>` +
        `<p class="c-text">${a.summary}</p>` +
        (a.bundled ? `<p class="c-line">Comes with OpenClaw, so it can be turned off but not removed.</p>` : "") +
        group("Tools") +
        `<ul class="c-list">${(a.servers || [[a.id, false]]).map(([s]) => `<li><span class="mono">${s}</span>, a tool server</li>`).join("")}${(a.skills || []).map((k) => `<li>${k}, a skill</li>`).join("")}</ul>` +
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
    const s = SERVERS[name];
    const last = params.get("last") || s.last;
    const lastRun = {
      tools: `<p class="c-state">8 tools, at Pip's run at 5:12 PM</p><details class="c-details"><summary>The tools</summary><p class="mono c-faint">${name}__search, ${name}__read_page, ${name}__add_page, …</p></details>`,
      notyet: `<p class="c-state">No bot has run since this was added. Its tools show after the next run.</p>`,
      unavailable: `<p class="c-state" data-tone="warn">Unavailable at Pip's run at 5:12 PM:</p><p class="mono c-warn">MCP server "${name}": ${s.kind === "command" ? `spawn ${s.command} ENOENT` : "fetch failed | connect ECONNREFUSED"}; server unavailable.</p>`,
      none: `<p class="c-state">Not reported: the gateway's tool list doesn't mention this server.</p>`,
    }[last];
    const rowsList = [
      ["Name on the gateway", `<span class="mono">${name}</span>`],
      ["Kind", s.kind === "remote" ? "Added by address" : "Runs a command"],
      ...(s.kind === "remote"
        ? [
            ["Address", `<span class="mono">${s.url}</span>`],
            ["Headers", s.headers.length ? `${s.headers.map((h) => `<span class="mono">${h}</span>`).join(", ")}. Hidden: the gateway doesn't show saved values. Kept by the gateway in its settings file, not encrypted there.` : "None"],
            ["Sign-in", s.signin === "oauth" ? "Signs in with OAuth" : s.signin === "each" ? "Uses the gateway\'s requester sign-in. Set up and use it in a channel where the gateway identifies each sender." : "None"],
          ]
        : [["Command", `<span class="mono">${esc([s.command, ...s.args].join(" "))}</span>`]]),
    ];
    const signedFromHere = params.get("signed") === "1";
    return {
      title: name,
      back: go("installed"),
      body:
        facts(rowsList) +
        group("What the last run found") +
        lastRun +
        group("Sign-in") +
        `<p class="c-state" data-c="signin">Not reported.</p>` +
        `<p class="c-line">The gateway doesn't report whether it's signed in to this server, or for whom. A bot's run shows whether its tools work.</p>` +
        (signedFromHere ? `<p class="c-line">Last signed in from Clawtrate: Nov 19, 5:12 PM.</p>` : "") +
        (s.signin === "each" ? `<p class="c-line">Uses the gateway's requester sign-in. Set up and use it in a channel where the gateway identifies each sender. Clawtrate offers no sign-in for it.</p>` : "") +
        (s.signin === "oauth" && admin ? `<div class="c-actions">${link("Sign in", preview ? "signin-starting" : "signin-cli", { id: name, server: "1" })}</div>` : "") +
        (s.kind === "remote"
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
    const base = from ? SERVERS[from] : null;
    const remote = type === "remote";
    return {
      title: "Add a custom connector",
      body:
        (admin
          ? `<form class="c-form" id="c-server-form" novalidate data-type="${type}">` +
            `<fieldset class="c-type"><legend>Type</legend><div class="c-seg" role="radiogroup" aria-label="Type">` +
            `<a role="radio" aria-checked="${remote}" href="${go("add-server", { type: "remote" })}">Remote HTTPS</a>` +
            `<a role="radio" aria-checked="${!remote}" href="${go("add-server", { type: "command" })}">Command</a></div></fieldset>` +
            field("c-name", "Name", "", "Letters, digits, hyphens and underscores. Bots see it in tool names.", "notes-work") +
            (remote
              ? field("c-url", "Server URL", base ? base.url : "", "", "https://") +
                `<fieldset class="c-headers"><legend>Headers</legend><div class="c-header-row"><input class="input" id="c-h-name" aria-label="Header name" placeholder="Name" value="${base ? "Authorization" : ""}" /><input class="input" id="c-h-value" type="password" aria-label="Header value" placeholder="Value" /></div>` +
                `<p class="c-line">Kept by the gateway in its settings file, not encrypted there. Clawtrate can't read a value back once it's saved.</p></fieldset>` +
                `<fieldset class="c-signin"><legend>Sign-in</legend>` +
                radio("signin", "none", "None", !base) +
                radio("signin", "oauth", "Sign in with OAuth", Boolean(base)) +
                `<p class="c-line">OpenClaw registers itself with the server when it signs in.</p></fieldset>`
              : field("c-command", "Command", "", "", "/path/to/server") +
                `<label class="c-field"><span>Arguments</span><textarea class="input" id="c-args" rows="3" aria-describedby="c-args-hint" placeholder="One per line"></textarea><span class="c-line" id="c-args-hint">One per line. Each is passed as one argument, never through a shell.</span></label>` +
                field("c-cwd", "Working folder", "", "Optional.", "") +
                `<p class="c-line">The gateway runs this program on its own machine, as the user the gateway runs as, whenever a bot's run needs its tools. It can do anything that user can.</p>`) +
            `<div class="c-actions"><button type="submit" class="button" data-variant="primary" data-size="sm">${remote ? "Add to gateway" : "Continue"}</button></div>` +
            `</form>`
          : `<p class="c-line">Adding a custom connector writes the gateway's settings.</p>`) +
        accessBar("Adding a custom connector needs admin access.") +
        granted(),
    };
  };
  const field = (id, label, value, hint, placeholder) =>
    `<label class="c-field"><span>${label}</span><input class="input" id="${id}" value="${esc(value)}" placeholder="${esc(placeholder)}" aria-describedby="${id}-error${hint ? ` ${id}-hint` : ""}" autocomplete="off" />` +
    `<span class="c-error" id="${id}-error" aria-live="polite"></span>${hint ? `<span class="c-line" id="${id}-hint">${hint}</span>` : ""}</label>`;
  const radio = (nameAttr, value, label, checked) =>
    `<label class="c-radio"><input type="radio" name="${nameAttr}" value="${value}"${checked ? " checked" : ""} /><span>${label}</span></label>`;

  // Sign-in (section 10) ------------------------------------------------------------------

  const signinTarget = () => {
    const id = params.get("id") || "calendrop";
    const isServer = params.get("server") === "1";
    return isServer ? { name: id, host: "auth.notes.example", back: go("server", { id }), isServer } : { name: app(id).name, host: app(id).host || "auth.example", back: go("connector", { id }), isServer, id };
  };
  const signin = (stage) => {
    const t = signinTarget();
    const keep = { id: params.get("id") || "calendrop", ...(t.isServer ? { server: "1" } : {}) };
    const done = t.isServer ? go("server", { id: t.name, signed: "1" }) : go("connector", { id: keep.id, auth: "authorized" });
    const bodies = {
      starting:
        `<p class="c-state" aria-busy="true">Asking the gateway to start the sign-in…</p>` +
        `<div class="c-actions">${link("Cancel", "signin-cancelled", keep, { variant: "quiet" })}</div>` +
        proto("the gateway answers", [
          link("With a sign-in page", "signin-waiting", keep, { variant: "quiet" }),
          link("\"Open Settings on this Gateway…\"", "signin-cli", keep, { variant: "quiet" }),
          link("\"This connector cannot…\"", "signin-cannot", keep, { variant: "quiet" }),
        ]),
      waiting:
        `<p class="c-text">Sign in on ${t.name}'s page.</p>` +
        address(t.host) +
        `<div class="c-open"><a class="button" data-variant="primary" data-size="sm" href="${go("signin-waiting", { ...keep, opened: "1" })}">Open in your browser</a></div>` +
        (params.get("opened") ? `<p class="c-line">Opened in a new tab of your browser.</p>` : "") +
        `<p class="c-state c-waiting">${CTglyph()}Waiting for the sign-in. This works for 10 minutes.</p>` +
        `<div class="c-actions">${link("Cancel", "signin-cancelled", keep, { variant: "quiet" })}</div>` +
        (params.get("loopback") === "1" ? note("", "", "The sign-in page returns to the gateway's own address, which only a browser on the gateway's machine can reach.") + cliSteps(t, keep) : "") +
        proto("the sign-in", [
          link("Approved", "signin-done", keep, { variant: "quiet" }),
          link("Refused", "signin-failed", keep, { variant: "quiet" }),
          link("10 minutes pass", "signin-expired", keep, { variant: "quiet" }),
          link("Drop connection", "signin-dropped", keep, { variant: "quiet" }),
        ]),
      done: result("ok", "check", `Signed in to ${t.name}.`, "The gateway keeps the sign-in.", `<a class="button" data-size="sm" href="${done}">Done</a>`),
      failed: result("danger", "x", "Sign-in didn't finish.", "Sign-in did not finish. Check the connector settings and try again, or run openclaw mcp login with this connector's name in this Gateway's terminal.", link("Try again", "signin-starting", keep)),
      expired: result("danger", "clock", "The sign-in expired", "before it finished.", link("Try again", "signin-starting", keep)),
      cancelled: result("", "x", "Sign-in cancelled.", "Nothing changed on the gateway.", `<a class="button" data-size="sm" href="${t.back}">Back</a>`),
      dropped: result("danger", "warning", "The sign-in ended with the connection.", "A sign-in belongs to the connection that started it. Start a new one once Clawtrate is connected again.", link("Try again", "signin-starting", keep)),
      cannot: note("danger", "The gateway can't start this sign-in from here.", "This connector cannot use operator browser sign-in. Check its existing account settings."),
      cli: `<p class="c-text">The gateway starts this sign-in from its own command line or its own settings page.</p>` + cliSteps(t, keep),
    };
    return { title: `Sign in to ${t.name}`, back: t.back, body: bodies[stage] };
  };
  // The gateway's command-line sign-in, in full (section 10).
  const cliSteps = (t, keep) =>
    `<ol class="b-steps c-steps"><li><p>On the gateway's machine, run:</p>${command(`openclaw mcp login ${t.isServer ? t.name : keep.id}`, "sign-in command")}</li>` +
    `<li><p>It prints an address. Open it in a browser and sign in to ${t.name}.</p></li>` +
    `<li><p>If that browser is on the gateway's machine, the command finishes by itself within 5 minutes and prints "MCP OAuth credentials saved". If it is on another computer, copy the code from the address the page returns to (the part after <code>code=</code>) and run:</p>${command(`openclaw mcp login ${t.isServer ? t.name : keep.id} --code <code>`, "finishing command")}</li></ol>` +
    `<p class="c-line">Or sign in from Settings on the gateway's own web page.</p>`;
  // A sign-in address, shown in full before it is opened: its host first, then the whole address.
  const address = (host) => {
    const full = `https://${host}/authorize?response_type=code&client_id=example-registered-client&state=example-state-7f3a`;
    return `<div class="c-address" aria-label="Sign-in address"><p class="c-address-host">${host}</p><p class="c-address-full mono">${esc(full)}</p>${copyButton("sign-in address", full)}</div>`;
  };
  const CTglyph = () => `<span class="glyph" data-state="waiting" aria-hidden="true"></span>`;

  // The conversation's connect card (section 11) -------------------------------------------

  const chat = () => {
    const card = params.get("card") || "open";
    const host = "auth.teamnotes.example";
    const cardHtml = {
      open:
        `<p class="c-card-title"><b>team-notes asks for a sign-in</b></p><p class="c-card-text">The gateway sees every device using Clawtrate as one sender, so this sign-in is shared by everyone who uses this gateway from Clawtrate.</p>` +
        address(host) +
        `<div class="c-open"><a class="button" data-size="sm" data-variant="primary" href="${go("chat", { card: "opened" })}">Open in your browser</a></div>` +
        `<p class="c-line">After you sign in, ask Pip again.</p>` +
        `<p class="c-line" data-tone="${params.get("shared") === "1" ? "warn" : ""}">Anyone who opens this link completes this sign-in.</p>`,
      opened:
        `<p class="c-card-title"><b>team-notes asks for a sign-in</b></p><p class="c-card-text">Opened at 5:12 PM. If the page didn't finish, open it again.</p>` +
        address(host) +
        `<div class="c-open"><a class="button" data-size="sm" href="${go("chat", { card: "opened" })}">Reopen</a></div>` +
        `<p class="c-line">After you sign in, ask Pip again.</p>` +
        `<p class="c-line">Anyone who opens this link completes this sign-in.</p>`,
      connected: `<p class="c-card-title">Used team-notes connect</p><p class="c-card-text">MCP server "team-notes" is connected. Its tools become available on the next message.</p>`,
      error: `<p class="c-card-title"><b>team-notes can't ask for a sign-in here:</b></p><p class="c-card-text mono">MCP server "team-notes" needs requester sign-in, but gateway.publicOrigin is not configured. Ask the operator to set the public Gateway HTTP(S) origin.</p>`,
    }[card];
    return (
      `<div class="c-chat"><div class="c-chat-head"><span class="c-chat-title">Pip · Standup notes</span></div><div class="c-transcript">` +
      `<div class="c-bubble">Add today's standup to team-notes.</div>` +
      `<article class="c-card" aria-label="Connect card">${initial("team-notes", "sm")}<div>${cardHtml}</div></article>` +
      `</div>` +
      proto("the bot's call returned", [
        link("A sign-in page", "chat", { card: "open" }, { variant: "quiet" }),
        link("Already connected", "chat", { card: "connected" }, { variant: "quiet" }),
        link("No public address", "chat", { card: "error" }, { variant: "quiet" }),
        link("In a shared task", "chat", { card: "open", shared: "1" }, { variant: "quiet" }),
      ]) +
      `</div>`
    );
  };

  // The picker (section 15) -----------------------------------------------------------------

  const picker = () =>
    `<div class="c-scrim"><div class="c-window c-picker" role="dialog" aria-modal="true" aria-labelledby="c-picker-title">` +
    `<div class="c-picker-body"><h2 id="c-picker-title">What do you use every day?</h2>` +
    `<p class="c-text">Pick the apps you use. Nothing is connected now; they come first in Connect apps.</p>` +
    search("Search apps") +
    `<ul class="c-tiles" id="c-tiles">${TILES.map((t) => `<li><label class="c-tile">${initial(t)}<span>${t}</span><input type="checkbox" value="${t}" /></label></li>`).join("")}</ul>` +
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
          `<div class="c-hero">${initial(a.name, "lg")}<div><p class="c-hero-name">${a.name}</p><p class="c-faint">by ${a.author}${a.official ? " · Official" : ""}</p></div></div>` +
          `<p class="c-text">${a.summary}</p>` +
          group("What it adds") +
          `<ul class="c-list">${(a.servers || []).map(([s, o]) => `<li><span class="mono">${s}</span>, a tool server${o ? " that signs in with OAuth" : ""}</li>`).join("")}${(a.skills || []).map((k) => `<li>${k}, a skill</li>`).join("")}</ul>` +
          group("About") +
          `<p class="c-text c-readme">${esc(a.readme || a.summary).replace(/\n/g, "<br />")}</p>` +
          `<p class="c-faint">Version ${a.version}</p>` +
          (a.local === "unavailable" ? `<p class="c-line">Not available for this gateway's version.</p>` : "") +
          granted(),
        foot: a.local === "install" ? (admin ? link("Add", "add-confirm", { id: a.id }, { variant: "primary" }) : accessBar("Adding apps needs admin access.")) : "",
      });
    },
    "add-confirm": () =>
      windowHtml({ title: A().name, back: go("app", { id: A().id }), body: "" }) +
      confirm(
        `Add ${A().name} to the gateway?`,
        `<p>The gateway downloads ${A().name} ${A().version} from the catalog and installs it, with the packages it depends on, on the gateway's machine. It then runs inside the gateway, with the gateway's access, and its tools are offered to bots that don't deny them. The gateway doesn't restart.</p>`,
        [link("Cancel", "app", { id: A().id }, { variant: "quiet", attrs: "data-autofocus" }), link("Add", params.get("ask") || "add-progress", { id: A().id }, { variant: "primary" })],
        proto("the gateway first asks for", [link("A review", "add-confirm", { id: A().id, ask: "add-consent" }, { variant: "quiet" }), link("An install warning", "add-confirm", { id: A().id, ask: "add-warning" }, { variant: "quiet" }), link("Nothing", "add-confirm", { id: A().id }, { variant: "quiet" })]),
      ),
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
    "add-done": () => windowHtml({ title: `Adding ${A().name}`, body: result("ok", "check", `Added ${A().name}.`, "It's turned on. Its tools reach bots from their next message.", link(`Open ${A().name}`, "connector", { id: A().id, auth: "unauthenticated" }, { variant: "primary" })) }),
    "add-restart": () => windowHtml({ title: `Adding ${A().name}`, body: result("", "warning", `Added ${A().name}.`, `The gateway says it needs a restart before ${A().name} works. Clawtrate doesn't restart the gateway.`) }),
    "add-refused": () => windowHtml({ title: `Adding ${A().name}`, body: result("danger", "x", `Couldn't add ${A().name}:`, "fetch failed. The gateway lists nothing new.", link("Try again", "add-confirm", { id: A().id })) }),
    "add-partial": () => windowHtml({ title: `Adding ${A().name}`, body: result("danger", "warning", `${A().name} was installed but didn't start:`, "quillnote: the module could not be loaded.", link(`Open ${A().name}`, "connector", { id: "boxwharf" })) }),
    "add-checking": () =>
      windowHtml({
        title: `Adding ${A().name}`,
        body: `<p class="c-state" aria-busy="true">Checking what the gateway has…</p>` + proto("the read-back", [link("Lists it", "add-done", { id: A().id }, { variant: "quiet" }), link("Doesn't list it", "add-refused", { id: A().id }, { variant: "quiet" })]),
      }),
    installed: () =>
      windowHtml({
        title: "On this gateway",
        body:
          search("Search what's on this gateway") +
          group("Turned on") +
          rows(APPS.filter((a) => !a.bundled && ["enabled", "error"].includes(a.local)), "connector") +
          group("Turned off") +
          rows(APPS.filter((a) => !a.bundled && ["disabled", "needs-setup"].includes(a.local)), "connector") +
          `<details class="c-fold"><summary>Comes with OpenClaw (${APPS.filter((a) => a.bundled).length})</summary>${rows(APPS.filter((a) => a.bundled), "connector")}</details>` +
          group("Tool servers") +
          `<ul class="c-rows">${Object.entries(SERVERS).map(([n, s]) => `<li class="c-row"><a class="c-row-main" href="${go("server", { id: n })}" aria-label="${n}, ${s.kind === "remote" ? "added by address" : "runs a command"}">${initial(n)}<span class="c-row-text"><span class="c-row-name mono">${n}</span><span class="c-row-sub">${s.kind === "remote" ? `Added by address · ${s.url}` : `Runs a command · ${esc(s.command)}`}</span></span></a></li>`).join("")}</ul>` +
          (admin ? `<div class="c-actions">${link("Add a custom connector", "add-server")}</div>` : ""),
      }),
    connector: () => windowHtml(connectorPage()),
    "turnoff-confirm": () => {
      const a = app(params.get("id"));
      return (
        windowHtml(connectorPage()) +
        confirm(
          `Turn off ${a.name}?`,
          `<p>Its tools stop reaching every bot on this gateway. Its settings and its sign-in stay.</p>`,
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
          goes([`${a.name}'s files on the gateway's machine`, "its settings on the gateway", params.get("bots") === "none" ? "its tools, from every bot that doesn't deny them" : "its tools, from every bot that has them: Juniper, Pip"], ["its sign-in, kept by the gateway in its state, not encrypted there", `a note on the gateway that ${a.name} is off, so nothing turns it back on by itself`]),
          [link("Cancel", "connector", { id: a.id }, { variant: "quiet" }), link("Remove", "removed", { id: a.id }, { variant: "primary" })],
          proto("the bots", [link("None has run since it was added", "remove-confirm", { id: a.id, bots: "none" }, { variant: "quiet" })]),
        )
      );
    },
    removed: () => {
      const a = app(params.get("id") || "tasktide");
      return windowHtml({ title: a.name, back: go("installed"), body: result("", "check", `Removed ${a.name}.`, "The gateway no longer lists it.") + goes([`${a.name}'s files`, "its settings", "its tools"], ["its sign-in, kept by the gateway in its state, not encrypted there", "the note that it is off"], "done") + `<div class="c-actions">${link("Back to the list", "installed")}</div>` });
    },
    server: () => windowHtml(serverPage()),
    "server-remove-confirm": () => {
      const name = params.get("id") || "notes-work";
      const s = SERVERS[name];
      return (
        windowHtml(serverPage()) +
        confirm(
          `Remove ${name} from the gateway?`,
          goes([`the server's entry in the gateway's settings${s.kind === "remote" ? ", with its headers" : ""}`, "its tools, from every bot that has them"], [s.signin === "oauth" ? "its sign-in, kept by the gateway in its state, not encrypted there. Removing the server does not delete it, and the gateway finds it again if a server with the same name and URL is added." : "nothing else: it has no sign-in the gateway keeps"]) +
            (s.signin === "oauth" ? `<p>To sign out first, run this on the gateway's machine before removing the server:</p>${command(`openclaw mcp logout ${name}`, "sign-out command")}` : ""),
          [link("Cancel", "server", { id: name }, { variant: "quiet" }), link("Remove", "server-removed", { id: name }, { variant: "primary" })],
          proto("the read-back", [link("Still lists it", "server-remove-failed", { id: name }, { variant: "quiet" })]),
        )
      );
    },
    "server-removed": () => {
      const name = params.get("id") || "notes-work";
      return windowHtml({ title: name, back: go("installed"), body: result("", "check", `Removed ${name}.`, "The gateway's settings no longer list it.") + `<div class="c-actions">${link("Back to the list", "installed")}</div>` });
    },
    "server-remove-failed": () => {
      const name = params.get("id") || "notes-work";
      return windowHtml({ title: name, back: go("server", { id: name }), body: note("danger", `${name} is still listed:`, "Another plugin or config operation is already running; retry when it completes.", `<div class="c-actions">${link("Try again", "server-remove-confirm", { id: name })}</div>`) });
    },
    "add-server": () => windowHtml(addServerForm()),
    "command-confirm": () =>
      windowHtml(addServerForm()) +
      confirm(
        "Run this command on the gateway's machine?",
        `<p>Home gateway will run, on its own machine (<span class="mono">studio.example</span>), as the user it runs as:</p>` +
          `<pre class="c-cmd">${esc([params.get("cmd") || "/opt/example/bin/search-server", ...(params.get("args") || "--stdio\n--index ./notes").split("\n")].join("\n"))}</pre>` +
          `<p>It runs whenever a bot's run needs ${esc(params.get("name") || "search-index")}'s tools, with that user's access to files, programs and the network.</p>`,
        [link("Cancel", "add-server", { type: "command" }, { variant: "quiet" }), link("Run it on the gateway", "add-server-saved", { name: params.get("name") || "search-index", type: "command" }, { variant: "primary" })],
      ),
    "add-server-saved": () => {
      const name = params.get("name") || "notes-work";
      const cmd = params.get("type") === "command";
      return windowHtml({
        title: "Add a custom connector",
        body:
          result("ok", "check", `Added ${esc(name)}.`, cmd ? "The gateway will run it at a bot's next run." : "The gateway lists it. Its tools reach bots from their next run, unless a bot's settings deny them.", link(`Open ${esc(name)}`, "server", { id: cmd ? "search-index" : "notes-work", last: "notyet" }, { variant: "primary" }) + (params.get("signin") === "oauth" ? link("Sign in", "signin-starting", { id: "notes-work", server: "1" }) : "")) +
          proto("the write", [link("Refused", "add-server-refused", { name }, { variant: "quiet" }), link("No answer", "add-server-checking", { name }, { variant: "quiet" })]),
      });
    },
    "add-server-refused": () => windowHtml({ title: "Add a custom connector", body: result("danger", "x", `Couldn't add ${esc(params.get("name") || "notes-work")}:`, `mcp.servers.${esc(params.get("name") || "notes-work")}.url: Expected http:// or https:// URL. Nothing saved.`, link("Back to the form", "add-server")) }),
    "add-server-checking": () => windowHtml({ title: "Add a custom connector", body: `<p class="c-state" aria-busy="true">Checking what the gateway has…</p>` + proto("the read-back", [link("Lists it", "add-server-saved", { name: params.get("name") || "notes-work" }, { variant: "quiet" }), link("Doesn't list it", "add-server-refused", { name: params.get("name") || "notes-work" }, { variant: "quiet" })]) }),
    "signin-starting": () => windowHtml(signin("starting")),
    "signin-waiting": () => windowHtml(signin("waiting")),
    "signin-done": () => windowHtml(signin("done")),
    "signin-failed": () => windowHtml(signin("failed")),
    "signin-expired": () => windowHtml(signin("expired")),
    "signin-cancelled": () => windowHtml(signin("cancelled")),
    "signin-dropped": () => windowHtml(signin("dropped")),
    "signin-cannot": () => windowHtml(signin("cannot")),
    "signin-cli": () => windowHtml(signin("cli")),
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
    "server-removed": `Removed ${params.get("id") || "notes-work"}`,
    "add-server-saved": `Added ${params.get("name") || "notes-work"}`,
    "add-server-refused": `Couldn't add ${params.get("name") || "notes-work"}`,
    "signin-waiting": "Waiting for the sign-in",
    "signin-done": `Signed in to ${signinTarget().name}`,
    "signin-failed": "Sign-in didn't finish",
    "signin-cancelled": "Sign-in cancelled",
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
      const skills = offline ? [] : SKILLS.filter((s) => `${s.name} ${s.text}`.toLowerCase().includes(text));
      results.innerHTML =
        !apps.length && !skills.length && !offline
          ? `<p class="c-state" data-c="none">No apps or skills match "${esc(q.value.trim())}".</p>`
          : group("Apps") +
            (apps.length ? rows(apps, offline ? "connector" : "app") : `<p class="c-line">No apps match.</p>`) +
            group("Skills") +
            (offline ? `<p class="c-line">Searching skills needs the catalog.</p>` : skills.length ? `<ul class="c-rows">${skills.map((s) => `<li class="c-row"><span class="c-row-main">${initial(s.name)}<span class="c-row-text"><span class="c-row-name">${s.name}</span><span class="c-row-sub">${s.text}</span></span></span></li>`).join("")}</ul>` : `<p class="c-line">No skills match.</p>`);
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
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const errors = [];
      const set = (id, message) => {
        const input = document.getElementById(id);
        document.getElementById(`${id}-error`).textContent = message;
        input.setAttribute("aria-invalid", message ? "true" : "false");
        if (message) errors.push(input);
      };
      const name = document.getElementById("c-name").value.trim();
      set("c-name", !name ? "Enter a name." : !/^[A-Za-z0-9_-]+$/.test(name) ? "Use letters, digits, hyphens and underscores." : SERVERS[name] ? `There's already a server named ${name}.` : "");
      if (form.dataset.type === "remote") {
        const url = document.getElementById("c-url").value.trim();
        let parsed = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        set("c-url", !url ? "Enter the server's URL." : !parsed || !/^https?:$/.test(parsed.protocol) ? "Enter a URL that starts with https://." : parsed.protocol !== "https:" ? "Use the server's https:// URL." : "");
        if (errors.length) return errors[0].focus();
        const signinChoice = form.querySelector("input[name='signin']:checked").value;
        location.href = go("add-server-saved", { name, signin: signinChoice });
      } else {
        const cmd = document.getElementById("c-command").value.trim();
        set("c-command", cmd ? "" : "Enter the command.");
        if (errors.length) return errors[0].focus();
        location.href = go("command-confirm", { name, cmd, args: document.getElementById("c-args").value.trim() || "" });
      }
    });
  }

  // Copy buttons: a check for 1.4 s, as conversation.md §9 has it.
  root.addEventListener("click", (event) => {
    const button = event.target.closest(".copy");
    if (!button) return;
    navigator.clipboard?.writeText(button.dataset.copy).catch(() => {});
    button.dataset.copied = "true";
    document.getElementById("c-live").textContent = `Copied ${button.getAttribute("aria-label").replace(/^Copy /, "")}`;
    setTimeout(() => delete button.dataset.copied, 1400);
  });
})();
