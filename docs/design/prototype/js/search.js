// Search (docs/design/search.md): the palette that Cmd/Ctrl+K and the rail's
// search button open, its sources and what each covers, opening a result in
// its place, and on the phone the full-screen search with scopes. On top of
// app.js. Nothing here talks to a gateway: the gateway's sources are a small
// local model that follows the gateway's own rules (docs/research/search.md),
// and every state can be set from the address (search.md, section 15).

(function () {
  const CT = window.CT;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => CT.icon(name);
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const GATEWAY = "Home gateway";

  // Fixtures --------------------------------------------------------------------------------------

  // Juniper's heat pump task gets a transcript with links, so the links source has something to
  // find in a conversation this device has loaded.
  const heatTranscript = () =>
    `<div class="stamp">Today 5:20 PM</div>` +
    `<div class="turn" data-role="user" data-testid="transcript-turn"><div class="msg" data-role="user"><div class="bubble">What should I ask an installer before signing anything?</div></div></div>` +
    `<div class="turn" data-role="assistant" data-testid="transcript-turn"><div class="msg" data-role="assistant"><div class="bubble md">` +
    `<p>A heat pump is sized from a heat-loss calculation, not from the old furnace's rating. Ask for that first. The sizing guide at <a href="#" data-href="https://energy.example/heat-pumps/sizing-guide">energy.example/heat-pumps/sizing-guide</a> lists what it should include.</p>` +
    `<p>Rebates change every year: <a href="#" data-href="https://energy.example/rebates/2026">energy.example/rebates/2026</a>. Ask these five, and get the answers in writing.</p>` +
    `<p>Your thermostat's own page is at <a href="#" data-href="http://127.0.0.1:8080/status">127.0.0.1:8080/status</a> if you want today's run times.</p>` +
    `</div></div></div>`;

  // The gateway's message index, as sessions.search sees it: the text of the person's messages and
  // the bots' replies, nothing else. `loaded` says whether the message is among the rows the
  // conversation shows (the latest 200); the weekly backup reports of Otto's task are older.
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 10, 18, 22, 0);
  const at = (daysAgo, hh = 9, mm = 0) => NOW - daysAgo * DAY - (22 - hh) * 3600000 + mm * 60000;
  const MESSAGES = [
    { bot: "otto", task: "o1", role: "user", ts: at(0, 17, 36), loaded: true, text: "Yes, clear the transcode cache." },
    { bot: "otto", task: "o1", role: "assistant", ts: at(0, 17, 33), loaded: true, text: "The usual suspects on a media box, largest first: /var/lib/transcode-cache, about 180 GB of temporary transcodes that were never cleaned up." },
    { bot: "otto", task: "o1", role: "assistant", ts: at(0, 17, 37), loaded: true, text: "Done. The disk is now at 61%. I moved the cache to transcode-cache.old instead of deleting it." },
    { bot: "otto", task: "o3", role: "user", ts: at(0, 14, 10), loaded: true, text: "Did last night's backup finish?" },
    { bot: "otto", task: "o3", role: "assistant", ts: at(0, 14, 14), loaded: true, text: "Yes. Last night's backup finished at 3:25 AM." },
    { bot: "marlow", task: "m1", role: "user", ts: at(1, 16, 2), loaded: true, text: "Keep a backup copy of the newsletter draft before you cut the intro, please." },
    { bot: "marlow", task: "m1", role: "assistant", ts: at(1, 16, 4), loaded: true, text: "Saved a backup copy as the March draft, then tightened the intro and cut about 80 words." },
    { bot: "pip", task: "p1", role: "user", ts: at(2, 15, 8), loaded: true, text: "Plan my week. Keep Thursday clear, and remind me to swap the backup drive on Friday." },
    { bot: "pip", task: "p1", role: "assistant", ts: at(2, 15, 10), loaded: true, text: "Here is the week, with Thursday kept clear and the backup drive swap on Friday morning." },
    { bot: "pip", task: "p3", role: "assistant", ts: at(9, 19, 30), loaded: true, text: "Booked for eight people at 7:30, with a backup table held at the second place until noon." },
    { bot: "juniper", task: "j1", role: "assistant", ts: at(0, 17, 20), loaded: true, text: "A heat pump is sized from a heat-loss calculation, not from the old furnace's rating. Ask for that first." },
  ];
  // Thirty weekly reports in Otto's backup task: short, so the gateway ranks them first.
  for (let week = 1; week <= 30; week++) {
    MESSAGES.push({ bot: "otto", task: "o3", role: "assistant", ts: at(week * 7, 3, 25), loaded: false, text: `Week ${week}: backup done, ${40 + (week % 7)} GB.` });
  }
  // A task the device's list does not hold (gone=unlisted): older than the newest 500.
  const UNLISTED = { bot: "otto", task: "x-old", title: "Old transcode settings", key: "agent:otto:old-transcode" };
  if (p("gone") === "unlisted") {
    MESSAGES.push({ bot: "otto", task: "x-old", role: "assistant", ts: at(400, 11, 0), loaded: false, text: "The transcode settings from last year are in the old notes folder." });
  }
  MESSAGES.forEach((m, i) => (m.id = `m${i + 1}`));

  // File names in each bot's workspace. Marlow's only task works in a folder of its own, so its
  // workspace is not searched through any of its tasks.
  const WORKSPACES = {
    juniper: { via: "j1", files: ["AGENTS.md", "notes/heat-pump-questions.md"] },
    otto: { via: "o1", files: ["AGENTS.md", "inventory.md", "notes/disk-2026-11-16.md", "notes/voice-memo.m4a", "notes/cache-walkthrough.mp4", "charts/usage.png", "tools/dashboard.js"] },
    marlow: { via: null, files: [] },
    pip: { via: "p1", files: ["AGENTS.md", "lists/mountain-weekend.md", "pictures/trail-map.png"] },
  };
  // Files the Work pane page can open in its reader (work.js keeps Otto's).
  const OPENS_IN_WORK = new Set(["inventory.md", "notes/disk-2026-11-16.md", "notes/voice-memo.m4a", "notes/cache-walkthrough.mp4", "charts/usage.png", "tools/dashboard.js"]);

  const ROUTINES = [
    { id: "r-tide", name: "Weekday tide digest", bot: "pip", enabled: false, description: "" },
    { id: "r-backup", name: "Monday backup report", bot: "otto", enabled: true, description: "Checks last week's backups and reports gaps." },
    { id: "r-read", name: "Morning reading digest", bot: "juniper", enabled: true, description: "" },
  ];

  const SETTINGS = [
    ["gateway", "Gateway", "The gateway, its address and this device"],
    ["accounts", "Accounts", "Provider accounts the bots run on"],
    ["integrations", "Integrations", "T3 Code"],
    ["permissions", "Permissions", "What each bot may do, and saved approvals"],
    ["memory", "Memory", "What the bots remember"],
    ["usage", "Usage", "Tokens, cost and warning budgets"],
    ["machines", "Machines", "Where the bots run"],
  ];

  // Matching, as the gateway and the device do it ----------------------------------------------------

  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // sessions.search: every word whole, the last also as a start (the scope form).
  function messageMatches(text, query) {
    const q = words(query);
    if (!q.length) return false;
    const w = words(text);
    return q.every((term, i) => w.some((word) => word === term || (i === q.length - 1 && word.startsWith(term))));
  }
  const contains = (text, query) => fold(text).includes(fold(query.trim()));
  // The device's marking: a word that begins with one of the query's words.
  function mark(text, query) {
    const q = words(query);
    return text
      .split(/([\p{L}\p{N}]+)/u)
      .map((part) => (/^[\p{L}\p{N}]+$/u.test(part) && q.some((term) => fold(part).startsWith(term)) ? `<b>${esc(part)}</b>` : esc(part)))
      .join("");
  }

  // The gateway's message search: bm25-like scores per bot (shorter scores higher), the best
  // `limit`, merged by score then time; `truncated` when more matched.
  function gatewayMessages(query, botId) {
    const hits = MESSAGES.filter((m) => (!botId || m.bot === botId) && messageMatches(m.text, query))
      .map((m) => ({ ...m, score: 100 / m.text.length }))
      .sort((a, b) => b.score - a.score || b.ts - a.ts);
    return { results: hits.slice(0, 25), truncated: hits.length > 25 };
  }

  // State ---------------------------------------------------------------------------------------------

  let app = null;
  const layer = () => $("#search-layer");
  const S = {
    open: false,
    query: "",
    scope: p("scope") || "all",
    opener: null,
    gen: 0, // the query generation; an answer for an older one is dropped
    timer: null,
    groups: {}, // gateway groups: messages, files, routines
    each: null, // search each bot: per bot answers
    shown: new Set(), // groups shown in full
    active: null, // the active option's id
    opening: null, // a message being opened: { id, state }
    attempts: { messages: 0, files: 0, routines: 0, history: 0 },
    loaded: new Set(p("links") === "none" ? [] : ["otto:o1", "juniper:j1"]), // conversations this device holds
    announceTimer: null,
    confirm: null, // the link confirmation's address
  };
  const src = p("src");
  const offline = () => ["reconnecting", "offline"].includes(app.model.connection);
  const phone = () => $("#root").getBoundingClientRect().width < 688;
  const botOf = (id) => app.bots.find((b) => b.id === id);
  const botName = (id) => botOf(id)?.name || id;
  const taskOf = (botId, taskId) => botOf(botId)?.tasks.find((t) => t.id === taskId) || null;
  const titleOf = (m) => (m.task === UNLISTED.task ? UNLISTED.title : taskOf(m.bot, m.task)?.title || m.task);
  const when = (ts) => {
    const d = new Date(ts);
    const days = Math.round((NOW - ts) / DAY);
    if (days < 1) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const list = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  // The device's sources: filtered at once ----------------------------------------------------------------

  function localGroups(query) {
    const q = query.trim();
    const bots = app.bots.filter((b) => contains(b.name, q)).map((b) => ({ kind: "bot", key: `bot:${b.id}`, bot: b.id, first: esc(b.name), second: esc(b.label), name: `Bot ${b.name}, ${b.label}` }));
    const tasks = [];
    for (const b of app.bots) for (const t of b.tasks) if (contains(t.title, q)) tasks.push({ kind: "task", key: `task:${b.id}:${t.id}`, bot: b.id, task: t.id, first: mark(t.title, q), second: `${esc(b.name)} · ${esc(t.when)}`, name: `Task ${t.title}, ${b.name}, ${t.when}` });
    const links = [];
    if (S.loaded.has("juniper:j1"))
      for (const href of ["https://energy.example/heat-pumps/sizing-guide", "https://energy.example/rebates/2026", "http://127.0.0.1:8080/status"]) {
        if (!contains(href, q)) continue;
        const u = new URL(href);
        links.push({ kind: "link", key: `link:${href}`, href, bot: "juniper", task: "j1", text: "heat-loss", first: `<span class="s-host">${esc(u.host)}</span><span class="s-path">${esc(u.pathname + u.search)}</span>`, second: `Heat pump vs. gas furnace · Juniper`, name: `Link ${u.host}${u.pathname}, in Heat pump vs. gas furnace. Shift+Enter opens it in your browser.` });
      }
    const settings = SETTINGS.filter(([, name, line]) => contains(name, q) || contains(line, q)).map(([id, name, line]) => ({ kind: "setting", key: `setting:${id}`, section: id, first: esc(name), second: esc(line), name: `Setting ${name}` }));
    const loadedCount = S.loaded.size;
    return {
      bots: { id: "bots", name: "Bots", rows: bots, state: "done", lines: [] },
      tasks: { id: "tasks", name: "Tasks", rows: tasks, state: "done", lines: [p("state") === "partial" ? "By name, in this device's task list, which holds the most recent tasks only" : "By name, in this device's task list"] },
      links: { id: "links", name: "Links", rows: links, state: "done", partial: loadedCount === 0, lines: [loadedCount ? `Only from the ${plural(loadedCount, "conversation")} this device has loaded` : "No conversation is loaded on this device yet"] },
      settings: { id: "settings", name: "Settings", rows: settings, state: "done", lines: [] },
    };
  }

  // The gateway's sources: asked after a pause -------------------------------------------------------------

  function ask() {
    const gen = ++S.gen;
    const q = S.query.trim();
    S.each = null;
    S.opening = null;
    S.shown.clear();
    if (!q) {
      S.groups = {};
      return render();
    }
    if (offline()) {
      for (const id of ["messages", "files", "routines"]) S.groups[id] = { state: "offline" };
      return render();
    }
    for (const id of ["messages", "files", "routines"]) S.groups[id] = { state: "searching" };
    if (q.length < 2) S.groups.files = { state: "short" };
    render();
    if (src === "slow") return;
    // Each source answers on its own; a slow one holds back nothing.
    setTimeout(() => gen === S.gen && answerMessages(q), 120);
    setTimeout(() => gen === S.gen && answerRoutines(q), 180);
    if (q.length >= 2) setTimeout(() => gen === S.gen && answerFiles(q), 260);
  }

  function answerMessages(q) {
    if (src === "msgfail" && S.attempts.messages++ === 0) {
      S.groups.messages = { state: "failed", error: "the gateway didn't answer in time" };
      announce("Messages couldn't be searched.");
    } else {
      const r = gatewayMessages(q);
      S.groups.messages = { state: "done", ...r, indexing: src === "indexing", archived: src === "archive" ? 4 : 0 };
      if (p("each") === "1" && r.truncated) return searchEach(q);
    }
    settle();
  }

  function answerRoutines(q) {
    if (src === "routinesfail" && S.attempts.routines++ === 0) {
      S.groups.routines = { state: "failed", error: "the gateway refused the request" };
      announce("Routines couldn't be searched.");
    } else {
      const ql = q.toLowerCase();
      const rows = ROUTINES.filter((r) => [r.id, r.name, r.description, r.bot].join(" ").toLowerCase().includes(ql));
      S.groups.routines = { state: "done", rows, total: rows.length, hasMore: false };
    }
    settle();
  }

  function answerFiles(q) {
    const ql = q.toLowerCase();
    const per = {};
    for (const [bot, ws] of Object.entries(WORKSPACES)) {
      if (!ws.via) per[bot] = { state: "notsearched" };
      else if (src === "filesfail" && bot === "pip" && S.attempts.files === 0) per[bot] = { state: "failed", error: "the gateway refused the request" };
      else per[bot] = { state: "done", rows: ws.files.filter((f) => f.toLowerCase().includes(ql)) };
    }
    if (src === "filesfail" && S.attempts.files === 0) announce("Pip's files couldn't be searched.");
    S.attempts.files++;
    S.groups.files = { state: "done", per };
    settle();
  }

  // Search each bot for more: one request per bot, four at a time.
  function searchEach(q) {
    S.each = {};
    for (const b of app.bots) S.each[b.id] = { state: "searching" };
    render();
    app.bots.forEach((b, i) =>
      setTimeout(() => {
        if (!S.each || S.query.trim() !== q) return;
        if (src === "eachfail" && b.id === "pip" && !S.each.pipRetried) S.each[b.id] = { state: "failed", error: "the gateway didn't answer in time" };
        else S.each[b.id] = { state: "done", ...gatewayMessages(q, b.id) };
        if (Object.values(S.each).every((e) => e.state !== "searching")) {
          const n = Object.values(S.each).reduce((sum, e) => sum + (e.results?.length || 0), 0);
          announce(`Searched each of ${plural(app.bots.length, "bot")}: ${plural(n, "message")}.`);
        }
        render();
      }, 60 + 40 * Math.floor(i / 4)),
    );
  }

  // The groups, in order, ready to draw ----------------------------------------------------------------------

  function messageRow(m, q) {
    const who = m.role === "user" ? "You" : botName(m.bot);
    return {
      kind: "message",
      key: `msg:${m.id}`,
      msg: m,
      bot: m.bot,
      first: `<span class="s-title">${esc(titleOf(m))}</span> · ${esc(who)} · <span class="s-time">${esc(when(m.ts))}</span>`,
      second: mark(m.text, q),
      clamp: true,
      name: `Message in ${titleOf(m)}, from ${m.role === "user" ? "you" : botName(m.bot)}, ${when(m.ts)}: ${m.text}`,
    };
  }

  function groups() {
    const q = S.query.trim();
    const local = localGroups(q);
    const out = [local.bots, local.tasks];
    // Messages
    const gm = S.groups.messages || { state: "searching" };
    const messages = { id: "messages", name: "Messages", rows: [], lines: [], actions: [], state: gm.state };
    if (gm.state === "done" && !S.each) {
      messages.rows = [...gm.results].sort((a, b) => b.ts - a.ts).map((m) => messageRow(m, q));
      messages.lines.push(gm.truncated ? "The gateway's 25 best matches across all bots, newest first. More messages match." : `All ${plural(gm.results.length, "matching message")}, newest first`);
      if (gm.truncated) messages.actions.push({ key: "act:each", label: "Search each bot for more", act: () => searchEach(q) });
    }
    if (gm.state === "done" && S.each) {
      messages.lines.push("Searched each bot, up to 25 matches from each");
      messages.sub = app.bots.map((b) => {
        const e = S.each[b.id];
        const rows = e.state === "done" ? [...e.results].sort((x, y) => y.ts - x.ts).map((m) => messageRow(m, q)) : [];
        const line =
          e.state === "searching" ? `${b.name} · Searching…`
          : e.state === "failed" ? `${b.name} · couldn't search: ${e.error}`
          : e.truncated ? `${b.name} · 25 best matches. More match; add words to narrow them.`
          : rows.length ? `${b.name} · all ${plural(rows.length, "match", "matches")}`
          : `${b.name} · no matches`;
        const actions = e.state === "failed" ? [{ key: `act:each-retry:${b.id}`, label: `Try again for ${b.name}`, act: () => { S.each.pipRetried = true; S.each[b.id] = { state: "done", ...gatewayMessages(q, b.id) }; render(); } }] : [];
        return { id: `messages-${b.id}`, name: b.name, line, tone: e.state === "failed" ? "danger" : null, rows, actions };
      });
      messages.rows = messages.sub.flatMap((s) => s.rows);
    }
    if (gm.state === "done") {
      messages.partial = Boolean(gm.indexing || gm.archived);
      if (gm.indexing) messages.lines.push("The gateway is still indexing some messages, so recent ones may be missing.");
      if (gm.archived) messages.lines.push(`${gm.archived} tasks' older messages are in the gateway's archive and weren't searched.`);
    }
    if (gm.state === "failed") {
      messages.lines.push(`Couldn't search messages: ${gm.error}.`);
      messages.tone = "danger";
      messages.actions.push({ key: "act:retry-messages", label: "Try again", act: () => { S.groups.messages = { state: "searching" }; render(); setTimeout(() => answerMessages(q), 100); } });
    }
    out.push(messages);
    // Files
    const gf = S.groups.files || { state: "searching" };
    const files = { id: "files", name: "Files", rows: [], lines: [], actions: [], state: gf.state };
    if (gf.state === "short") {
      files.lines.push("Type 2 or more characters to search file names.");
      files.state = "note";
    }
    if (gf.state === "done") {
      const searched = Object.entries(gf.per).filter(([, v]) => v.state === "done").map(([bot]) => botName(bot));
      const found = Object.values(gf.per).some((v) => v.state === "done" && v.rows.length);
      files.partial = Object.values(gf.per).some((v) => v.state !== "done");
      files.lines.push(found || !files.partial ? `Names in the workspaces of ${list(searched)}` : `No match in the workspaces of ${list(searched)}.`);
      for (const [bot, v] of Object.entries(gf.per)) {
        if (v.state === "notsearched") files.lines.push(`Not searched: ${botName(bot)}, none of whose tasks works in its workspace.`);
        if (v.state === "failed") {
          files.lines.push(`${botName(bot)}: couldn't search files: ${v.error}.`);
          files.tone = "danger";
          files.actions.push({ key: `act:retry-files:${bot}`, label: `Try again for ${botName(bot)}`, act: () => { answerFiles(q); } });
        }
        if (v.state === "done")
          for (const path of v.rows) {
            const name = path.split("/").pop();
            const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : `${botName(bot)}'s workspace`;
            files.rows.push({ kind: "file", key: `file:${bot}:${path}`, bot, path, first: esc(name), second: `${esc(folder)} · ${esc(botName(bot))}`, name: `File ${path}, ${botName(bot)}` });
          }
      }
    }
    out.push(files);
    out.push(local.links);
    // Routines
    const gr = S.groups.routines || { state: "searching" };
    const routines = { id: "routines", name: "Routines", rows: [], lines: [], actions: [], state: gr.state };
    if (gr.state === "done") {
      routines.lines.push("By name and description");
      routines.rows = gr.rows.map((r) => ({ kind: "routine", key: `routine:${r.id}`, bot: r.bot, first: mark(r.name, q), second: `${esc(botName(r.bot))} · ${r.enabled ? "On" : "Off"}`, name: `Routine ${r.name}, ${botName(r.bot)}, ${r.enabled ? "on" : "off"}. Opens ${botName(r.bot)}.` }));
    }
    if (gr.state === "failed") {
      routines.lines.push(`Couldn't search routines: ${gr.error}.`);
      routines.tone = "danger";
      routines.actions.push({ key: "act:retry-routines", label: "Try again", act: () => { S.groups.routines = { state: "searching" }; render(); setTimeout(() => answerRoutines(q), 100); } });
    }
    out.push(routines);
    out.push(local.settings);
    for (const g of out) {
      if (g.state === "searching") g.lines = ["Searching…"];
      if (g.state === "offline") g.lines = [`Not searched: ${GATEWAY} isn't connected. Search runs again when it reconnects.`];
    }
    return out;
  }

  // Which groups a scope shows on the phone.
  const SCOPES = [
    ["all", "All"],
    ["messages", "Messages"],
    ["bots", "Bots"],
    ["groups", "Group Chats"],
    ["files", "Files"],
    ["routines", "Routines"],
  ];
  const inScope = (id) =>
    !phone() || S.scope === "all" || (S.scope === "messages" && ["tasks", "messages", "links"].includes(id)) || S.scope === id;

  // Drawing ---------------------------------------------------------------------------------------------

  let options = []; // the options in order, with what each does

  function render() {
    if (!S.open) return;
    const L = layer();
    const q = S.query.trim();
    options = [];
    const isPhone = phone();
    L.dataset.form = isPhone ? "phone" : "palette";
    let body = "";
    if (isPhone && S.scope === "groups") {
      body = `<p class="s-solo">Group chats aren't part of Clawtrate yet.</p>`;
    } else if (!q) {
      body = idle();
    } else {
      body = results(groups(), q, isPhone);
    }
    const field = $("#s-field", L);
    if (!field) {
      L.innerHTML =
        `<div class="s-scrim" data-s="scrim"></div>` +
        `<div class="s-palette" role="dialog" aria-modal="true" aria-label="Search">` +
        `<div class="s-top"><span class="s-glass">${icon("search")}</span>` +
        `<input id="s-field" class="s-field" type="text" role="combobox" aria-expanded="false" aria-controls="s-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" maxlength="4096" enterkeyhint="search" />` +
        `<button type="button" class="button s-cancel" data-variant="quiet" data-s="cancel">Cancel</button></div>` +
        `<div class="s-scopes" role="tablist" aria-label="Search in"></div>` +
        `<div class="s-body" id="s-body" role="tabpanel" aria-label="Results"></div>` +
        `<p class="s-foot" aria-hidden="true"></p>` +
        `<p class="visually-hidden" id="s-live" role="status" aria-live="polite"></p>` +
        `<div class="s-confirm-layer" hidden></div></div>`;
      const f = $("#s-field", L);
      f.value = S.query;
      f.addEventListener("input", () => onInput(f.value));
      f.addEventListener("keydown", onKey);
    }
    const f = $("#s-field", L);
    f.placeholder = isPhone ? "Search" : "Search bots, tasks, messages, files, links, routines and settings";
    $(".s-scopes", L).hidden = !isPhone;
    $(".s-body", L).setAttribute("role", isPhone ? "tabpanel" : "presentation");
    if (isPhone) {
      $(".s-scopes", L).innerHTML = SCOPES.map(
        ([id, label]) => `<button type="button" role="tab" class="s-scope" id="s-scope-${id}" data-scope="${id}" aria-selected="${S.scope === id}" tabindex="${S.scope === id ? 0 : -1}">${label}</button>`,
      ).join("");
    }
    $("#s-body", L).innerHTML = body;
    CT.hydrate($("#s-body", L));
    // The active option: kept by identity, else the first.
    if (!options.some((o) => o.key === S.active)) S.active = options[0]?.key || null;
    f.setAttribute("aria-expanded", String(options.length > 0));
    paintActive();
    const activeOpt = options.find((o) => o.key === S.active);
    $(".s-foot", L).textContent = `↑↓ Move · ↵ Open · Esc Close${activeOpt?.row?.kind === "link" ? " · ⇧↵ Open in browser" : ""}`;
    $(".s-palette", L).dataset.confirm = S.confirm ? "open" : "";
  }

  function idle() {
    const partial = p("state") === "partial";
    const n = S.loaded.size;
    const rows = [
      ["Bots", "Every bot, by name."],
      ["Tasks", `Task names in this device's task list${partial ? ", which holds the most recent tasks only" : ""}.`],
      ["Messages", "Your messages and the bots' replies, in every bot's tasks. Not steps, tool results, reasoning or archived tasks."],
      ["Files", "File names in each bot's workspace."],
      ["Links", n ? `Links in the conversations loaded on this device: ${n} now.` : "Links in conversations you open. None is loaded now."],
      ["Routines", "Routines, by name and description."],
      ["Settings", "Clawtrate's settings."],
    ];
    return `<section class="s-idle" aria-labelledby="s-idle-title"><h2 class="s-group-name" id="s-idle-title">What search looks in</h2><dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>`;
  }

  function results(all, q, isPhone) {
    const visible = all.filter((g) => inScope(g.id));
    const hasRows = visible.some((g) => g.rows.length);
    const pending = visible.some((g) => g.state === "searching");
    let html = `<div class="s-list" id="s-list" role="listbox" aria-label="Results">`;
    for (const g of visible) {
      // A group searched only in part keeps its own coverage line; it is never folded into "No match".
      const drawn = g.rows.length || g.state !== "done" || g.tone || g.partial || (g.actions && g.actions.length);
      if (!drawn) continue;
      html += group(g, q, isPhone);
    }
    html += `</div>`;
    // "No results" is said only when every source answered; a source searched in part says how far.
    const complete = visible.every((g) => g.state === "done" && !g.tone);
    if (!hasRows && !pending && complete) {
      const none = visible.filter((g) => g.state === "done" && !g.rows.length);
      html = `<section class="s-none" aria-labelledby="s-none-title"><h2 id="s-none-title">No results for “${esc(q)}”</h2><dl>${none.map((g) => `<div><dt>${g.name}</dt><dd>${esc(g.partial ? g.lines.join(" ") : noneLine(g.id))}</dd></div>`).join("")}</dl></section>`;
    } else if (!pending) {
      const none = visible.filter((g) => g.state === "done" && !g.rows.length && !g.tone && !g.partial).map((g) => g.name);
      if (none.length) html += `<p class="s-nomatch">No match in ${list(none)}.</p>`;
    }
    return html;
  }

  function noneLine(id) {
    return {
      bots: "Every bot, by name.",
      tasks: "Task names in this device's task list.",
      messages: "Your messages and the bots' replies, in every bot's tasks. Messages match whole words; the last word may be the start of one.",
      files: `File names in the workspaces of ${list(Object.entries(WORKSPACES).filter(([, w]) => w.via).map(([b]) => botName(b)))}.`,
      links: `Links in the ${plural(S.loaded.size, "conversation")} loaded on this device.`,
      routines: "Routines, by name and description.",
      settings: "Clawtrate's settings.",
    }[id];
  }

  function group(g, q, isPhone) {
    const limit = isPhone && S.scope === "all" ? 3 : 5;
    const full = S.shown.has(g.id) || (isPhone && S.scope !== "all");
    const headId = `s-g-${g.id}`;
    const descId = `s-gd-${g.id}`;
    let html = `<div class="s-group" role="group" aria-labelledby="${headId}" aria-describedby="${descId}" data-group="${g.id}"${g.tone ? ` data-tone="${g.tone}"` : ""}>`;
    html += `<div class="s-group-head" role="presentation"><span class="s-group-name" id="${headId}">${g.name}${g.rows.length ? ` · ${g.rows.length}` : ""}</span>`;
    html += `<span class="s-group-lines" id="${descId}">${g.lines.map((l) => `<span class="s-line">${esc(l)}</span>`).join("")}</span></div>`;
    if (g.state === "searching") html += `<div class="s-skeleton" aria-hidden="true"><span></span><span></span></div>`;
    if (g.sub) {
      for (const s of g.sub) {
        html += `<div class="s-sub" role="presentation"${s.tone ? ` data-tone="${s.tone}"` : ""}><span class="s-sub-line" id="s-sub-${s.id}">${esc(s.line)}</span></div>`;
        const rows = full ? s.rows : s.rows.slice(0, limit);
        html += rows.map((r) => row(r)).join("");
        if (!full && s.rows.length > limit) html += action({ key: `act:all:${s.id}`, label: `Show all ${s.rows.length} of ${s.name}'s messages`, act: () => { S.shown.add(g.id); render(); } });
        html += s.actions.map(action).join("");
      }
    } else {
      const rows = full ? g.rows : g.rows.slice(0, limit);
      html += rows.map((r) => row(r)).join("");
      if (!full && g.rows.length > limit) {
        const noun = g.name.toLowerCase();
        html += isPhone
          ? action({ key: `act:see:${g.id}`, label: `See all ${g.rows.length} ${noun}`, act: () => setScope(g.id === "tasks" || g.id === "links" ? "messages" : g.id) })
          : action({ key: `act:all:${g.id}`, label: `Show all ${g.rows.length} ${noun}`, act: () => { S.shown.add(g.id); render(); } });
      }
    }
    html += (g.actions || []).map(action).join("");
    return html + `</div>`;
  }

  function hintFor(r) {
    return { bot: "Open", task: "Open", message: "Go to message", file: "Open in Work", link: "Go to message", routine: `Open ${botName(r.bot)}`, setting: "Open" }[r.kind];
  }

  function leading(r) {
    if (r.kind === "bot" || r.kind === "task" || r.kind === "message") return `<span class="avatar" data-bot="${r.bot}"></span>`;
    return `<span class="s-icon">${icon({ file: "file", link: "link", routine: "clock", setting: "settings" }[r.kind])}</span>`;
  }

  function row(r) {
    const id = `s-o-${options.length}`;
    options.push({ key: r.key, id, row: r });
    const blocked = blockedLine(r);
    const opening = S.opening && S.opening.key === r.key ? S.opening : null;
    const note = blocked || (opening && opening.note) || "";
    const name = r.name + (note ? `. ${note}` : "");
    return (
      `<div class="s-row" role="option" id="${id}" data-key="${esc(r.key)}" data-kind="${r.kind}" aria-selected="false" aria-label="${esc(name)}">` +
      `<span class="s-lead">${leading(r)}</span>` +
      `<span class="s-text"><span class="s-first">${r.first}</span>${r.second ? `<span class="s-second${r.clamp ? " s-clamp" : ""}">${r.second}</span>` : ""}` +
      (opening && opening.state === "opening" ? `<span class="s-note">Opening…</span>` : "") +
      (note ? `<span class="s-note" data-tone="${blocked ? "muted" : "warn"}">${esc(note)}</span>` : "") +
      `</span>` +
      `<span class="s-hint">${esc(blocked ? "Can't open" : hintFor(r))}${r.kind === "link" ? `<span class="s-hint-more">⇧↵ Open in browser</span>` : ""}</span>` +
      `</div>` +
      (opening && opening.state === "older" ? action({ key: "act:latest", label: "Open the task at its latest", act: () => close(false) }) : "") +
      (opening && opening.state === "failed" ? action({ key: "act:retry-open", label: "Try again", act: () => openRow(r) }) : "")
    );
  }

  function action(a) {
    const id = `s-o-${options.length}`;
    options.push({ key: a.key, id, act: a.act });
    return `<div class="s-row s-action" role="option" id="${id}" data-key="${esc(a.key)}" aria-selected="false">${esc(a.label)}</div>`;
  }

  function paintActive() {
    const L = layer();
    for (const el of $$(".s-row", L)) el.setAttribute("aria-selected", String(el.dataset.key === S.active));
    const opt = options.find((o) => o.key === S.active);
    const f = $("#s-field", L);
    if (opt) {
      f.setAttribute("aria-activedescendant", opt.id);
      $(`#${opt.id}`, L)?.scrollIntoView({ block: "nearest" });
    } else f.removeAttribute("aria-activedescendant");
    const foot = $(".s-foot", L);
    if (foot) foot.textContent = `↑↓ Move · ↵ Open · Esc Close${opt?.row?.kind === "link" ? " · ⇧↵ Open in browser" : ""}`;
  }

  // What cannot open, and why (section 9) ---------------------------------------------------------------------

  function blockedLine(r) {
    if (!["message", "link", "file"].includes(r.kind)) return "";
    const gone = p("gone");
    if (gone === "bot" && r.bot === "otto") return "Otto is no longer on this gateway.";
    if (r.kind === "message" && r.msg.task === UNLISTED.task) return "This task isn't in this device's task list, which holds the newest 500 tasks.";
    if (gone === "task" && r.kind === "message" && r.msg.task === "o1" && S.left) return "This task is no longer on the gateway's list: it was archived or deleted.";
    return "";
  }

  // Opening a result in its place --------------------------------------------------------------------------------

  function openRow(r) {
    if (blockedLine(r)) return announce(blockedLine(r));
    if (r.kind === "message" && p("gone") === "task" && r.msg.task === "o1") {
      // The task left the list after the results came.
      S.left = true;
      render();
      return announce(blockedLine(r));
    }
    if (r.kind === "bot" || r.kind === "routine") {
      close(false);
      app.selectBot(r.bot);
      return said(`Opened ${botName(r.bot)}.`);
    }
    if (r.kind === "task") {
      close(false);
      app.openTask(r.bot, r.task);
      return said(`Opened ${taskOf(r.bot, r.task).title}.`);
    }
    if (r.kind === "setting") {
      location.href = `controls.html?open=settings&section=${r.section}${carry()}`;
      return;
    }
    if (r.kind === "file") {
      const path = OPENS_IN_WORK.has(r.path) && r.bot === "otto" ? `&file=${encodeURIComponent(r.path)}` : "";
      location.href = `work.html?bot=${r.bot}&task=${WORKSPACES[r.bot].via}&panel=open&tab=files${path}${carry()}`;
      return;
    }
    // A message, or the message that holds a link: the task opens behind the palette.
    const m = r.kind === "message" ? r.msg : { bot: r.bot, task: r.task, role: "assistant", ts: at(0, 17, 20), loaded: true, text: "A heat pump is sized from a heat-loss calculation" };
    app.openTask(m.bot, m.task);
    S.loaded.add(`${m.bot}:${m.task}`);
    S.opening = { key: r.key, state: "opening" };
    render();
    setTimeout(() => {
      if (!S.opening || S.opening.key !== r.key) return;
      if (p("historyfail") === "1" && S.attempts.history++ === 0) {
        S.opening = { key: r.key, state: "failed", note: "Couldn't load this conversation: the gateway didn't answer in time." };
        render();
        return announce(S.opening.note);
      }
      const loaded = m.loaded && p("older") !== "1";
      if (!loaded) {
        S.opening = { key: r.key, state: "older", note: "This message is earlier than the 200 messages a conversation shows, so it can't be shown in place." };
        render();
        return announce(S.opening.note);
      }
      close(false);
      goToMessage(m);
    }, 260);
  }

  const carry = () => ["theme", "width", "motion", "chrome"].map((k) => (p(k) ? `&${k}=${p(k)}` : "")).join("");

  function goToMessage(m) {
    const needle = m.text.slice(0, 28);
    const turn = $$("#transcript .turn").find((t) => t.textContent.replace(/\s+/g, " ").includes(needle));
    if (!turn) return;
    const bubble = $(".bubble", turn);
    turn.tabIndex = -1;
    turn.scrollIntoView({ block: "nearest" });
    turn.focus({ preventScroll: true });
    bubble.classList.add("search-hit");
    const reduced = document.documentElement.dataset.motion === "reduce" || matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      const clear = () => {
        bubble.classList.remove("search-hit");
        removeEventListener("keydown", clear, true);
        $("#transcript").removeEventListener("scroll", clear);
      };
      setTimeout(() => {
        addEventListener("keydown", clear, true);
        $("#transcript").addEventListener("scroll", clear);
      }, 50);
    } else bubble.addEventListener("animationend", () => bubble.classList.remove("search-hit"), { once: true });
    const task = taskOf(m.bot, m.task);
    said(`Opened ${task.title}, at ${m.role === "user" ? "your message" : `${botName(m.bot)}'s reply`} of ${when(m.ts)}.`);
  }

  // The link confirmation (docs/decisions.md, "Addresses a gateway hands the client").
  function confirmLink(href) {
    const u = new URL(href);
    const local = /^(127\.|localhost$|10\.|192\.168\.)/.test(u.hostname);
    S.confirm = href;
    const L = $(".s-confirm-layer", layer());
    L.hidden = false;
    L.innerHTML =
      `<div class="s-confirm" role="alertdialog" aria-modal="true" aria-labelledby="s-confirm-title" aria-describedby="s-confirm-text">` +
      `<h2 id="s-confirm-title">Open this link?</h2>` +
      `<p class="s-confirm-address" id="s-confirm-text"><b>${esc(u.host)}</b>${esc(href.slice(href.indexOf(u.host) + u.host.length))}</p>` +
      `<p class="s-confirm-line">Opens in your browser.${local ? " This address is on this computer." : ""}</p>` +
      `<div class="s-confirm-actions"><button type="button" class="button" data-s="confirm-cancel">Cancel</button><button type="button" class="button" data-variant="primary" data-s="confirm-open">Open</button></div></div>`;
    $('[data-s="confirm-cancel"]', L).focus();
  }
  function closeConfirm(opened) {
    const L = $(".s-confirm-layer", layer());
    L.hidden = true;
    L.innerHTML = "";
    S.confirm = null;
    if (opened) {
      close(true);
      return said("In the app, the link opens in your browser. This prototype opens nothing.");
    }
    $("#s-field").focus();
  }

  // Input and keys ------------------------------------------------------------------------------------------

  function onInput(value) {
    S.query = value;
    S.left = false;
    clearTimeout(S.timer);
    // The device's groups now; the gateway's after a 250 ms pause.
    for (const id of ["messages", "files", "routines"]) if (S.groups[id] && S.groups[id].state !== "offline") S.groups[id] = { ...S.groups[id], stale: true };
    S.groups = value.trim() ? { messages: { state: "searching" }, files: { state: value.trim().length < 2 ? "short" : "searching" }, routines: { state: "searching" } } : {};
    if (value.trim() && offline()) for (const id of ["messages", "files", "routines"]) S.groups[id] = { state: "offline" };
    S.each = null;
    render();
    S.timer = setTimeout(ask, 250);
  }

  function move(step) {
    const i = options.findIndex((o) => o.key === S.active);
    const next = options[Math.max(0, Math.min(options.length - 1, i + step))];
    if (next) S.active = next.key;
    paintActive();
  }
  function moveGroup(dir) {
    const L = layer();
    const el = S.active && $(`[data-key="${CSS.escape(S.active)}"]`, L);
    // The nearest group in that direction that has an option.
    const groupsEls = $$(".s-group", L).filter((g) => $(".s-row", g));
    const gi = groupsEls.findIndex((g) => g.contains(el));
    const target = groupsEls[Math.max(0, Math.min(groupsEls.length - 1, gi + dir))];
    const first = target && $(".s-row", target);
    if (first) S.active = first.dataset.key;
    paintActive();
  }

  function activate(shift) {
    const opt = options.find((o) => o.key === S.active);
    if (!opt) return;
    if (opt.act) return opt.act();
    if (shift && opt.row.kind === "link") return confirmLink(opt.row.href);
    if (shift) return;
    openRow(opt.row);
  }

  function onKey(event) {
    if (event.key === "ArrowDown") return event.preventDefault(), move(1);
    if (event.key === "ArrowUp") return event.preventDefault(), move(-1);
    if (event.key === "PageDown") return event.preventDefault(), moveGroup(1);
    if (event.key === "PageUp") return event.preventDefault(), moveGroup(-1);
    if (event.key === "Enter") return event.preventDefault(), activate(event.shiftKey);
  }

  function setScope(id) {
    S.scope = id;
    S.active = null;
    render();
    $(`#s-scope-${id}`)?.focus();
  }

  // Opening and closing --------------------------------------------------------------------------------------

  function open(from) {
    if (S.open) {
      $("#s-field").select();
      return;
    }
    S.open = true;
    S.opener = from || document.activeElement;
    const L = layer();
    L.hidden = false;
    L.innerHTML = "";
    $$('[data-action="search"]').forEach((b) => b.setAttribute("aria-expanded", "true"));
    render();
    const f = $("#s-field");
    f.focus();
    if (S.query) {
      f.value = S.query;
      onInput(S.query);
    }
  }

  function close(restoreFocus = true) {
    if (!S.open) return;
    S.open = false;
    clearTimeout(S.timer);
    S.query = ""; // the query goes with the palette
    S.groups = {};
    S.each = null;
    S.opening = null;
    S.gen++;
    S.confirm = null;
    S.scope = "all";
    const L = layer();
    L.hidden = true;
    L.innerHTML = "";
    $$('[data-action="search"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (restoreFocus && S.opener && document.contains(S.opener)) S.opener.focus();
  }

  function announce(text) {
    const live = $("#s-live");
    if (live) {
      live.textContent = "";
      setTimeout(() => (live.textContent = text), 30);
    }
  }
  function said(text) {
    const el = $("#search-announce");
    el.textContent = "";
    setTimeout(() => (el.textContent = text), 30);
  }

  // Once results for a query settle, say what came back (section 12).
  function settle() {
    render();
    clearTimeout(S.announceTimer);
    S.announceTimer = setTimeout(() => {
      // Once each bot is being searched, its own announcement says what came back.
      if (!S.open || S.each) return;
      const all = groups().filter((g) => inScope(g.id));
      if (all.some((g) => g.state === "searching")) return;
      const q = S.query.trim();
      const counts = all.filter((g) => g.rows.length).map((g) => plural(g.rows.length, g.name.toLowerCase().replace(/s$/, ""), g.name.toLowerCase()));
      const total = all.reduce((n, g) => n + g.rows.length, 0);
      const extra = [];
      if (S.groups.messages?.truncated && !S.each) extra.push("More messages match.");
      const gf = S.groups.files;
      if (gf?.per) for (const [bot, v] of Object.entries(gf.per)) if (v.state === "notsearched") extra.push(`${botName(bot)}'s files weren't searched.`);
      announce(total ? `${plural(total, "result")}: ${counts.join(", ")}. ${extra.join(" ")}`.trim() : `No results for ${q}.`);
    }, 400);
  }

  // The app's extension ----------------------------------------------------------------------------------------

  CT.appExtension = {
    fixtures(bots) {
      const t = (bot, id) => bots.find((b) => b.id === bot)?.tasks.find((x) => x.id === id);
      const j1 = t("juniper", "j1");
      if (j1) j1.html = heatTranscript();
      // The conversations the message fixtures point into show those messages.
      const set = (bot, id, ask, preview) => {
        const x = t(bot, id);
        if (x) Object.assign(x, ask ? { ask } : {}, { preview });
      };
      const of = (task, role) => MESSAGES.find((m) => m.task === task && m.role === role).text;
      set("marlow", "m1", of("m1", "user"), of("m1", "assistant"));
      set("pip", "p1", of("p1", "user"), of("p1", "assistant"));
      set("pip", "p3", null, of("p3", "assistant"));
    },
    connectionChanged(name) {
      // The gateway's sources are asked again when the connection returns.
      if (S.open && name === "connected" && S.query.trim()) ask();
      else if (S.open) render();
    },
    ready(a) {
      app = a;
      // The rail's search button opens the palette; it is caught before app.js's own handler.
      document.addEventListener(
        "click",
        (event) => {
          const button = event.target.closest('[data-action="search"]');
          if (button) {
            event.stopPropagation();
            event.preventDefault();
            open(button);
            return;
          }
          if (!S.open) return;
          const L = layer();
          if (!L.contains(event.target)) return;
          const s = event.target.closest("[data-s]")?.dataset.s;
          if (s === "scrim" || s === "cancel") return close(true);
          if (s === "confirm-cancel") return closeConfirm(false);
          if (s === "confirm-open") return closeConfirm(true);
          const scope = event.target.closest("[data-scope]");
          if (scope) return setScope(scope.dataset.scope);
          const more = event.target.closest(".s-hint-more");
          const rowEl = event.target.closest(".s-row");
          if (rowEl) {
            S.active = rowEl.dataset.key;
            paintActive();
            activate(Boolean(more));
            if (S.open && !S.confirm) $("#s-field")?.focus();
          }
        },
        true,
      );
      // Cmd/Ctrl+K anywhere, unless another modal dialog is open; Escape closes.
      document.addEventListener(
        "keydown",
        (event) => {
          const command = isMac ? event.metaKey : event.ctrlKey;
          if (command && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "k") {
            if (!S.open && document.querySelector("dialog[open]")) return;
            event.preventDefault();
            event.stopPropagation();
            return open(document.activeElement);
          }
          if (!S.open) return;
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            return S.confirm ? closeConfirm(false) : close(true);
          }
          // The phone's scope bar: Left, Right, Home, End.
          const scope = event.target.closest?.("[data-scope]");
          if (scope && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const ids = SCOPES.map(([id]) => id);
            const i = ids.indexOf(scope.dataset.scope);
            const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, i + (event.key === "ArrowRight" ? 1 : -1)));
            return setScope(ids[next]);
          }
          // Tab stays in the palette: the field alone on the desktop; field, Cancel, scopes on the phone.
          if (event.key === "Tab") {
            const stops = phone() ? [$("#s-field"), $(".s-cancel"), $(`#s-scope-${S.scope}`)] : [$("#s-field")];
            if (S.confirm) {
              const b = $$(".s-confirm button");
              const i = b.indexOf(document.activeElement);
              event.preventDefault();
              return b[(i + (event.shiftKey ? b.length - 1 : 1)) % b.length].focus();
            }
            event.preventDefault();
            const i = stops.indexOf(document.activeElement);
            stops[(i + (event.shiftKey ? stops.length - 1 : 1) + stops.length) % stops.length].focus();
          }
        },
        true,
      );
      if (p("palette") === "open" || p("q")) {
        S.query = p("q") || "";
        open($('[data-action="search"]'));
      }
    },
  };
})();
