// Search (docs/design/search.md): the palette that Cmd/Ctrl+K and the rail's
// search button open, its sources and what each covers, opening a result in
// its place, and on the phone the full-screen search with scopes. On top of
// app.js. Nothing here talks to a gateway: the gateway's sources are a small
// local model that follows the gateway's own rules (docs/research/search.md),
// and every state can be set from the address (search.md, section 15).
//
// Two rules hold the whole file together. Each source keeps its own coverage,
// and the screen and the live region are drawn from that one state, so neither
// can say more than the replies established. Every reply, retry, open and
// announcement carries the generation it was started in, and anything from an
// earlier query or an earlier connection is dropped before it changes anything.

(function () {
  const CT = window.CT;
  const p = (name) => CT.params.get(name);
  const src = new Set((p("src") || "").split(",").filter(Boolean));
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name) => CT.icon(name);
  // The platform is a fixture of its own, distinct from the width: the iPhone app, or a desktop
  // (the Mac, or anything else, which uses Ctrl).
  const PLATFORM = p("platform") || (/Mac/.test(navigator.platform || navigator.userAgent) ? "mac" : "other");
  const IOS = PLATFORM === "ios";
  const MOD = PLATFORM === "mac" || IOS ? "⌘" : "Ctrl+";
  const SOFT_KEYBOARD = IOS && p("keyboard") !== "hardware";
  const OPENS = IOS ? "Opens outside Clawtrate." : "Opens in your browser.";
  const GATEWAY = "Home gateway";
  const TIMEOUT = 8000; // a request that has not answered by then is given up
  const MESSAGE_DELAY = Number(p("delay")) || 120;
  const ROUTINE_PAGE = Number(p("routinepage")) || 50;
  const EACH_CAP = 24; // bots asked by one "Search each bot for more"
  const FILES_CAP = 8; // bots' workspaces asked per batch; the next batch on request
  const POOL = 4; // requests in flight at once, within one source's batch

  // Fixtures --------------------------------------------------------------------------------------

  const DAY = 86400000;
  const NOW = Date.UTC(2026, 10, 18, 22, 0);
  const at = (daysAgo, hh = 9, mm = 0) => NOW - daysAgo * DAY - (22 - hh) * 3600000 + mm * 60000;
  const keyOf = (bot, task) => `agent:${bot}:${task}`;
  // A turn of a conversation with the history row's id, as the conversation draws it.
  const turnHtml = (role, id, html) =>
    `<div class="turn" data-role="${role}" data-testid="transcript-turn" data-message-id="${id}"><div class="msg" data-role="${role}"><div class="bubble${role === "assistant" ? " md" : ""}">${html}</div></div></div>`;

  // The gateway's message index, as sessions.search sees it: the text of user and assistant
  // messages, by message id. `turn` is the message's place in the task's loaded rows; a message
  // without one is not among them.
  const MESSAGES = [
    { id: "msg-o1-1", bot: "otto", task: "o1", turn: 1, role: "assistant", ts: at(0, 17, 33), text: "The usual suspects on a media box, largest first: /var/lib/transcode-cache, about 180 GB of temporary transcodes that were never cleaned up." },
    { id: "msg-o1-2", bot: "otto", task: "o1", turn: 2, role: "user", ts: at(0, 17, 36), text: "Yes, clear the transcode cache." },
    { id: "msg-o1-3", bot: "otto", task: "o1", turn: 3, role: "assistant", ts: at(0, 17, 37), text: "Done. The disk is now at 61%. I moved the cache to transcode-cache.old instead of deleting it." },
    { id: "msg-o3-0", bot: "otto", task: "o3", turn: 0, role: "user", ts: at(0, 14, 10), text: "Did last night's backup finish?" },
    { id: "msg-o3-1", bot: "otto", task: "o3", turn: 1, role: "assistant", ts: at(0, 14, 14), text: "Yes. Last night's backup finished at 3:25 AM." },
    { id: "msg-m1-0", bot: "marlow", task: "m1", turn: 0, role: "user", ts: at(1, 16, 2), text: "Keep a backup copy of the newsletter draft before you cut the intro, please." },
    { id: "msg-m1-1", bot: "marlow", task: "m1", turn: 1, role: "assistant", ts: at(1, 16, 4), text: "Saved a backup copy as the March draft, then tightened the intro and cut about 80 words." },
    { id: "msg-p1-0", bot: "pip", task: "p1", turn: 0, role: "user", ts: at(2, 15, 8), text: "Plan my week. Keep Thursday clear, and remind me to swap the backup drive on Friday." },
    { id: "msg-p1-1", bot: "pip", task: "p1", turn: 1, role: "assistant", ts: at(2, 15, 10), text: "Here is the week, with Thursday kept clear and the backup drive swap on Friday morning." },
    { id: "msg-p3-0", bot: "pip", task: "p3", turn: 0, role: "assistant", ts: at(9, 19, 30), text: "Booked for eight people at 7:30, with a backup table held at the second place until noon." },
    { id: "msg-j1-1", bot: "juniper", task: "j1", turn: 1, role: "assistant", ts: at(0, 17, 20), text: "A heat pump is sized from a heat-loss calculation, not from the old furnace's rating. Ask for that first." },
    // Text with markup characters in it: the snippet must show them as text.
    { id: "msg-j2-1", bot: "juniper", task: "j2", turn: 1, role: "assistant", ts: at(0, 15, 2), text: "Libby shows <em>Borrow</em> once your card is linked." },
  ];
  // Thirty weekly reports in Otto's backup task, short, so the gateway ranks them first. They are
  // older than the 200 rows the conversation loads.
  for (let week = 1; week <= 30; week++)
    MESSAGES.push({ id: `msg-o3-w${week}`, bot: "otto", task: "o3", role: "assistant", ts: at(week * 7, 3, 25), text: `Week ${week}: backup done, ${40 + (week % 7)} GB.` });
  // A task the device's list does not hold (gone=unlisted); the reply's session rows name it.
  const UNLISTED = { bot: "otto", task: "x-old", title: "Old transcode settings" };
  if (p("gone") === "unlisted")
    MESSAGES.push({ id: "msg-x-1", bot: "otto", task: "x-old", role: "assistant", ts: at(400, 11, 0), text: "The transcode settings from last year are in the old notes folder." });
  // missing=1: a message newer than the loaded window's oldest row, and not among the rows.
  if (p("missing") === "1")
    MESSAGES.push({ id: "msg-o1-x", bot: "otto", task: "o1", role: "assistant", ts: at(0, 17, 35), text: "Clearing the transcode cache frees about 180 GB." });

  // The loaded window of each conversation: how many rows, whether the gateway has more, and the
  // oldest loaded row's time. Only Otto's backup task is longer than the 200 rows the app loads.
  const WINDOWS = { o3: { rows: 200, hasMore: true, oldest: at(1, 2, 0) } };
  const windowOf = (task) => WINDOWS[task] || { rows: 4, hasMore: false, oldest: at(30) };

  // Links in the loaded conversations, as the conversation's own link controls hold them. An
  // address the core refuses is plain text in the conversation, and in search.
  const LONG = "https://energy.example/heat-pumps/sizing-guide/appendix/heat-loss-worksheet?climate-zone=5A&rooms=kitchen,living,bedrooms,basement&units=imperial#step-4";
  const heatTranscript = () =>
    `<div class="stamp">Today 5:20 PM</div>` +
    turnHtml("user", "msg-j1-0", "What should I ask an installer before signing anything?") +
    turnHtml(
      "assistant",
      "msg-j1-1",
      `<p>A heat pump is sized from a heat-loss calculation, not from the old furnace's rating. Ask for that first. The sizing guide at <a href="#" data-href="https://energy.example/heat-pumps/sizing-guide">energy.example/heat-pumps/sizing-guide</a> lists what it should include, and its worksheet is at <a href="#" data-href="${LONG}">the worksheet</a>.</p>` +
        `<p>Rebates change every year: <a href="#" data-href="https://energy.example/rebates/2026">energy.example/rebates/2026</a>. Ask these five, and get the answers in writing.</p>` +
        `<p>Your thermostat's own page is at <a href="#" data-href="http://127.0.0.1:8080/status">127.0.0.1:8080/status</a>, and the heat pump's at <a href="#" data-href="http://[fd00::40]/heatpump">[fd00::40]/heatpump</a>, if you want today's run times.</p>` +
        `<p>The installer's portal: <span class="plain-address" data-href="https://sam:hunter2@installer.example.com/portal">https://sam:hunter2@installer.example.com/portal</span></p>`,
    );

  // File names in each bot's workspace, as sessions.files.list returns them: files and folders.
  // A bot's workspace is searched through a task whose row carries none of the four root fields;
  // Marlow's only task works in a folder of its own, so its workspace can't be verified.
  const WORKSPACES = {
    juniper: { via: "j1", root: "/srv/openclaw/workspaces/juniper", entries: [["AGENTS.md", "file"], ["notes", "directory"], ["notes/heat-pump-questions.md", "file"]] },
    otto: {
      via: "o1",
      root: "/srv/openclaw/workspaces/otto",
      entries: [["AGENTS.md", "file"], ["inventory.md", "file"], ["notes", "directory"], ["notes/disk-2026-11-16.md", "file"], ["notes/voice-memo.m4a", "file"], ["notes/cache-walkthrough.mp4", "file"], ["charts", "directory"], ["charts/usage.png", "file"], ["tools/dashboard.js", "file"]],
    },
    marlow: { via: p("marlow") === "workspace" ? "m1" : null, root: "/srv/openclaw/workspaces/marlow", entries: [["AGENTS.md", "file"], ["drafts/newsletter-march.md", "file"]] },
    pip: { via: "p1", root: "/srv/openclaw/workspaces/pip", entries: [["AGENTS.md", "file"], ["lists/mountain-weekend.md", "file"], ["pictures", "directory"], ["pictures/trail-map.png", "file"]] },
  };
  // A file result is a name: nothing binds a reader's read to the workspace that was searched.
  const FILE_LINE = "Opening a file from search is unavailable until the gateway can bind the read to the workspace searched.";

  // Routines, by the ids routines.html holds, so a result opens that routine's page.
  const ROUTINES = [
    { id: "digest", name: "Morning digest", bot: "marlow", enabled: true, description: "" },
    { id: "reminder", name: "Send the draft to Sam", bot: "marlow", enabled: true, description: "" },
    { id: "backup", name: "Nightly backup check", bot: "otto", enabled: true, description: "" },
    { id: "watch", name: "Disk space watch", bot: "otto", enabled: true, description: "" },
    { id: "renewal", name: "Certificate renewal", bot: "otto", enabled: true, description: "" },
    { id: "standup", name: "Plan the week", bot: "pip", enabled: true, description: "" },
    { id: "cleanup", name: "Inbox tidy-up", bot: "pip", enabled: false, description: "" },
  ];

  // The sections the Settings this page opens (controls.html) registers, in its order. The app
  // derives its rows from its own Settings sections the same way.
  const SETTINGS = [
    ["gateway", "Gateway", "The gateway, its address and this device"],
    ["accounts", "Accounts", "Provider accounts the bots run on"],
    ["integrations", "Integrations", "T3 Code"],
    ["permissions", "Permissions", "What each bot may do, and saved approvals"],
    ["memory", "Memory", "What the bots remember"],
    ["usage", "Usage", "Tokens, cost and warning budgets"],
    ["machines", "Machines", "Where the bots run"],
  ];

  // bots=30: a roster large enough to reach the caps of "Search each bot" and of Files.
  const EXTRA_NAMES = ["Aster", "Basil", "Cedar", "Dune", "Ember", "Fern", "Gale", "Hazel", "Iris", "Jade", "Kestrel", "Lark", "Moss", "Nettle", "Opal", "Pike", "Quill", "Rowan", "Sage", "Thistle", "Umber", "Vale", "Wren", "Yarrow", "Zinnia", "Alder"];
  const EXTRA = Math.max(0, Math.min(EXTRA_NAMES.length, (Number(p("bots")) || 4) - 4));

  // Matching, as the gateway and the device do it ----------------------------------------------------

  const fold = (s) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const tokens = (s) => fold(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  // sessions.search, scope form: whitespace-delimited pieces are quoted as FTS5 phrases, each a
  // phrase of the words SQLite finds in it (punctuation splits them, and they must stay together and
  // in order), every piece must match, and the last word of the last piece may be the start of a
  // word. A piece that does not produce a token matches no messages.
  function messageMatches(text, query) {
    const pieces = query.trim().split(/\s+/u).filter(Boolean);
    if (!pieces.length) return false;
    const w = tokens(text);
    return pieces.every((piece, pi) => {
      const t = tokens(piece);
      if (!t.length) return false;
      const prefixLast = pi === pieces.length - 1;
      for (let i = 0; i + t.length <= w.length; i++)
        if (t.every((term, j) => w[i + j] === term || (prefixLast && j === t.length - 1 && w[i + j].startsWith(term)))) return true;
      return false;
    });
  }
  const contains = (text, query) => fold(text).includes(fold(query.trim()));
  // Marks where the device itself found the query in text it matched (a task's title). The folded
  // text keeps one character per original character, so the ranges map back.
  function markFound(text, query) {
    const q = fold(query.trim());
    if (!q) return esc(text);
    const chars = [...text];
    const folded = chars.map((c) => fold(c) || c);
    const flat = folded.join("");
    const starts = new Map();
    let pos = 0;
    folded.forEach((f, i) => {
      starts.set(pos, i);
      pos += f.length;
    });
    const marked = new Array(chars.length).fill(false);
    for (let from = flat.indexOf(q); from !== -1; from = flat.indexOf(q, from + q.length)) {
      if (!starts.has(from) || !starts.has(from + q.length) && from + q.length !== flat.length) continue;
      const a = starts.get(from);
      const b = from + q.length === flat.length ? chars.length : starts.get(from + q.length);
      for (let i = a; i < b; i++) marked[i] = true;
    }
    let out = "";
    chars.forEach((c, i) => {
      if (marked[i] && !marked[i - 1]) out += "<b>";
      out += esc(c);
      if (marked[i] && !marked[i + 1]) out += "</b>";
    });
    return out;
  }

  // The address rule (docs/decisions.md, "Addresses a gateway hands the client") --------------------

  // One parsed address: its canonical serialization, or why it is refused.
  function canonical(raw) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      return { refused: "it isn't a complete address" };
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") return { refused: "only web addresses open from Clawtrate" };
    if (u.username || u.password) return { refused: "it carries a user name or password" };
    return { url: u.href, host: u.host, hostname: u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "") };
  }
  const v4 = (h) => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
    return m ? m.slice(1).map(Number) : null;
  };
  const inV4 = (a, [b, bits]) => {
    const n = (x) => ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3];
    const mask = bits ? (~0 << (32 - bits)) >>> 0 : 0;
    return ((n(a) & mask) >>> 0) === ((n(b) & mask) >>> 0);
  };
  // IPv4 entries of the special-purpose registry that are not globally reachable, then the globally
  // reachable entries inside them; the longest matching prefix decides.
  const V4_GLOBAL = [[[192, 0, 0, 9], 32], [[192, 0, 0, 10], 32]];
  const V4_LOCAL = [[[0, 0, 0, 0], 8], [[10, 0, 0, 0], 8], [[100, 64, 0, 0], 10], [[169, 254, 0, 0], 16], [[172, 16, 0, 0], 12], [[192, 0, 0, 0], 24], [[192, 0, 2, 0], 24], [[192, 168, 0, 0], 16], [[198, 18, 0, 0], 15], [[198, 51, 100, 0], 24], [[203, 0, 113, 0], 24], [[224, 0, 0, 0], 4], [[240, 0, 0, 0], 4]];
  const v6 = (h) => {
    if (!h.includes(":")) return null;
    const [head, tail] = h.split("::");
    const part = (s) => (s ? s.split(":") : []);
    let groups = [...part(head)];
    let rest = part(tail);
    const last = (tail !== undefined ? rest : groups).at(-1) || "";
    let mapped = null;
    if (last.includes(".")) {
      mapped = v4(last);
      if (tail !== undefined) rest = rest.slice(0, -1);
      else groups = groups.slice(0, -1);
    }
    const fill = 8 - groups.length - rest.length - (mapped ? 2 : 0);
    const all = [...groups, ...(tail !== undefined ? new Array(Math.max(0, fill)).fill("0") : []), ...rest].map((g) => parseInt(g || "0", 16));
    if (mapped) all.push((mapped[0] << 8) + mapped[1], (mapped[2] << 8) + mapped[3]);
    return all.length === 8 ? all : null;
  };
  const inV6 = (g, [prefix, bits]) => {
    const p6 = v6(prefix);
    return g.every((x, i) => {
      const take = Math.max(0, Math.min(16, bits - i * 16));
      const mask = (0xffff << (16 - take)) & 0xffff;
      return (x & mask) === (p6[i] & mask);
    });
  };
  // Inside 2000::/3, the registry's entries that are not globally reachable, then the globally
  // reachable entries inside 2001::/23.
  const V6_LOCAL = [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]];
  const V6_GLOBAL = [["2001:1::1", 128], ["2001:1::2", 128], ["2001:3::", 32], ["2001:4:112::", 48], ["2001:20::", 28], ["2001:30::", 28]];
  // Local when the longest matching prefix is a local entry.
  const localByPrefix = (inside, local, global) => {
    const best = (entries) => Math.max(-1, ...entries.filter((e) => inside(e)).map(([, bits]) => bits));
    return best(local) > best(global);
  };
  const v4Where = (a) => (a[0] === 127 ? "self" : localByPrefix((r) => inV4(a, r), V4_LOCAL, V4_GLOBAL) ? "network" : "");
  // The written host only, never a lookup: "self" for loopback and localhost names, "network" for
  // any other literal the preview check refuses, a .local name or a name without a dot.
  function whereIs(hostname) {
    const h = hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost")) return "self";
    const a = v4(h);
    if (a) return v4Where(a);
    const g = v6(h);
    if (g) {
      if (g.every((x, i) => (i < 7 ? x === 0 : x === 1))) return "self";
      if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
        return v4Where([g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255]);
      }
      const global = (g[0] & 0xe000) === 0x2000 && !localByPrefix((r) => inV6(g, r), V6_LOCAL, V6_GLOBAL);
      if (g[0] === 0x64 && g[1] === 0xff9b) return "network";
      return global ? "" : "network";
    }
    if (h.endsWith(".local") || !h.includes(".")) return "network";
    return "";
  }
  const LOCAL_LINE = { self: "This address points to this device.", network: "This address may be on your own network." };

  // State ---------------------------------------------------------------------------------------------

  let app = null;
  const layer = () => $("#search-layer");
  const S = {
    open: false,
    query: "",
    scope: p("scope") || "all",
    opener: null,
    gen: 0, // advanced on every change to the text and every change of connection
    timer: null,
    groups: {}, // the gateway's sources: messages, files, routines
    shown: new Set(), // groups shown in full
    active: null,
    opening: null, // a result being opened: { key, state, note, token }
    loaded: new Set(p("links") === "none" ? [] : ["otto:o1", "juniper:j1"]), // conversations this device holds
    announceTimer: null,
    confirm: null,
    lanes: {}, // one request per source in flight: { busy, waiting }
    removed: new Set(), // task keys that left the device's list after the results came
    botsGone: new Set(),
    openToken: 0,
  };
  // What the check can read: every request sent, and every address handed to the system.
  const TEST = { requests: [], handoffs: [], answered: [], out: {}, peak: {}, canonical: (raw) => canonical(raw), whereIs: (host) => whereIs(host) };
  CT.searchTest = TEST;
  const offline = () => ["reconnecting", "offline"].includes(app.model.connection);
  const phone = () => $("#root").getBoundingClientRect().width < 688;
  const roster = () => app.bots.filter((b) => !S.botsGone.has(b.id));
  const botOf = (id) => app.bots.find((b) => b.id === id);
  const botName = (id) => botOf(id)?.name || id;
  const taskOf = (botId, taskId) => botOf(botId)?.tasks.find((t) => t.id === taskId) || null;
  // The device's task list now: its rows by key, with their session id.
  function listRow(key) {
    if (S.removed.has(key)) return null;
    for (const b of roster()) for (const t of b.tasks) if (keyOf(b.id, t.id) === key) return { bot: b.id, task: t.id, sessionId: t.sessionId, title: t.title, roots: t.roots };
    return null;
  }
  const when = (ts) => {
    const d = new Date(ts);
    if (NOW - ts < DAY) return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  };
  const list = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  // The gateway, as requests and replies ----------------------------------------------------------------

  // One request: recorded, answered after its delay, given up after TIMEOUT. The reply reaches
  // `then` only while the generation it was sent in is current.
  function send(source, params, delay, answer, then) {
    const gen = S.gen;
    const req = { source, params, gen, done: false };
    TEST.requests.push({ source, ...params });
    TEST.out[source] = (TEST.out[source] || 0) + 1;
    TEST.peak[source] = Math.max(TEST.peak[source] || 0, TEST.out[source]);
    const finish = (reply) => {
      if (req.done) return;
      req.done = true;
      TEST.out[source] -= 1;
      TEST.answered.push({ source, gen, current: gen === S.gen });
      then(reply, gen === S.gen);
    };
    if (!src.has("slow")) setTimeout(() => finish(answer()), delay);
    setTimeout(() => finish({ error: "timeout" }), TIMEOUT);
  }

  // A source's lane: one request in flight; while it is out, only the latest query waits, with the
  // generation that queued it, and it is sent only while that generation is still current.
  function lane(source, run) {
    const l = (S.lanes[source] ||= { busy: false, waiting: null });
    if (l.busy) {
      l.waiting = { run, gen: S.gen };
      return;
    }
    l.busy = true;
    run(() => {
      l.busy = false;
      const next = l.waiting;
      l.waiting = null;
      if (next?.gen === S.gen) lane(source, next.run);
    });
  }

  function gatewayMessages(query, botId) {
    const visible = new Set(roster().map((b) => b.id));
    const hits = MESSAGES.filter((m) => visible.has(m.bot) && (!botId || m.bot === botId) && messageMatches(m.text, query))
      .map((m) => ({ ...m, score: 100 / m.text.length }))
      .sort((a, b) => b.score - a.score || b.ts - a.ts);
    const results = hits.slice(0, 25).map((m) => ({ sessionKey: keyOf(m.bot, m.task), sessionId: `s-${m.task}`, messageId: m.id, role: m.role, timestamp: m.ts, snippet: m.text, bot: m.bot, task: m.task }));
    const sessions = [...new Set(results.map((r) => r.sessionKey))].map((key) => ({ key, label: key.endsWith(UNLISTED.task) ? UNLISTED.title : listRow(key)?.title }));
    return { results, sessions, ...(hits.length > 25 ? { truncated: true } : {}), ...(src.has("indexing") ? { indexing: true } : {}), ...(src.has("archive") ? { archivedTranscriptsExcluded: 4 } : {}) };
  }

  // The device's sources: filtered at once ----------------------------------------------------------------

  // Links from the loaded conversations' own link controls, each with its message's identity.
  function linkIndex() {
    const out = [];
    const parser = new DOMParser();
    for (const b of roster())
      for (const t of b.tasks) {
        if (!S.loaded.has(`${b.id}:${t.id}`) || !t.html) continue;
        const doc = parser.parseFromString(t.html, "text/html");
        for (const el of doc.querySelectorAll(".turn[data-message-id] [data-href]")) {
          const turn = el.closest(".turn");
          if (!["user", "assistant"].includes(turn.dataset.role)) continue;
          out.push({ raw: el.dataset.href, bot: b.id, task: t.id, sessionKey: keyOf(b.id, t.id), sessionId: t.sessionId, messageId: turn.dataset.messageId, role: turn.dataset.role });
        }
      }
    return out;
  }

  function localGroups(q) {
    const R = roster();
    const rosterFailed = p("roster") === "failed";
    const discovering = p("state") === "discovering";
    const bots = R.filter((b) => contains(b.name, q)).map((b) => ({ kind: "bot", key: `bot:${b.id}`, bot: b.id, first: markFound(b.name, q), second: esc(b.label), name: `Bot ${b.name}, ${b.label}` }));
    const tasks = [];
    for (const b of R)
      for (const t of b.tasks)
        if (contains(t.title, q)) tasks.push({ kind: "task", key: `task:${keyOf(b.id, t.id)}`, bot: b.id, task: t.id, sessionKey: keyOf(b.id, t.id), sessionId: t.sessionId, first: markFound(t.title, q), second: `${esc(b.name)} · ${esc(t.when)}`, name: `Task ${t.title}, ${b.name}, ${t.when}` });
    const links = [];
    for (const l of linkIndex()) {
      const c = canonical(l.raw);
      const shown = c.url || l.raw;
      if (!contains(shown, q)) continue;
      const task = taskOf(l.bot, l.task);
      const where = c.url ? whereIs(c.hostname) : "";
      links.push({
        kind: "link",
        key: `link:${l.messageId}:${shown}`,
        ...l,
        url: c.url || null,
        refused: c.refused || null,
        where,
        first: `<span class="s-host">${esc(c.host || shown)}</span>`,
        address: esc(shown),
        second: `${esc(task.title)} · ${esc(botName(l.bot))}`,
        name: c.url
          ? `Link ${c.url}, in ${task.title}. ${IOS ? "Open link opens it outside Clawtrate." : "Shift+Enter opens it in your browser."}`
          : `Address ${shown}, in ${task.title}. It can't be opened from Clawtrate: ${c.refused}.`,
      });
    }
    const settings = SETTINGS.filter(([, name, line]) => contains(name, q) || contains(line, q)).map(([id, name, line]) => ({ kind: "setting", key: `setting:${id}`, section: id, first: markFound(name, q), second: esc(line), name: `Setting ${name}` }));
    const n = S.loaded.size;
    const tasksCut = p("state") === "partial";
    return {
      bots: {
        id: "bots",
        name: "Bots",
        rows: bots,
        state: "done",
        complete: !rosterFailed && !discovering,
        lines: rosterFailed ? ["Couldn't load the gateway's bots. Showing the bots loaded before."] : discovering ? ["The gateway's bots haven't loaded yet."] : [],
        none: "Every bot this connection can see, by name",
        say: rosterFailed ? "The gateway's bots couldn't be loaded." : discovering ? "The gateway's bots haven't loaded." : "",
      },
      tasks: {
        id: "tasks",
        name: "Tasks",
        rows: tasks,
        state: "done",
        complete: !tasksCut && !rosterFailed && !discovering,
        lines: [
          rosterFailed
            ? "Couldn't load the task list. Titles in the tasks loaded before."
            : tasksCut
              ? "Titles in this device's task list, which was cut short: it holds the most recent tasks only."
              : "Titles in this device's task list, which keeps up to 500 tasks",
        ],
        none: "Titles in this device's task list, which keeps up to 500 tasks",
        say: rosterFailed ? "The task list couldn't be loaded." : tasksCut ? "The task list holds the most recent tasks only." : "",
      },
      links: {
        id: "links",
        name: "Links",
        rows: links,
        state: "done",
        complete: n > 0,
        lines: [n ? `Only from the ${plural(n, "conversation")} this device has loaded` : "No conversation is loaded on this device yet"],
        none: `Links in the ${plural(n, "conversation")} this device has loaded`,
        say: n ? "" : "No conversation is loaded, so no links were searched.",
      },
      settings: { id: "settings", name: "Settings", rows: settings, state: "done", complete: true, lines: [], none: "The sections of Clawtrate's Settings", say: "" },
    };
  }

  // The gateway's sources: asked after a pause -------------------------------------------------------------

  const asks = (id) => !phone() || S.scope === "all" || (S.scope === "messages" && id === "messages") || S.scope === id;

  function ask() {
    const q = S.query.trim();
    S.shown.clear();
    if (!q) return render();
    if (offline()) {
      for (const id of ["messages", "files", "routines"]) S.groups[id] = { state: "offline" };
      return settle(); // nothing is asked, and the live region says what wasn't searched
    }
    if (asks("messages") && !S.groups.messages?.asked) askMessages(q);
    if (asks("routines") && !S.groups.routines?.asked) askRoutines(q, 0);
    if (asks("files") && !S.groups.files?.asked) {
      if (q.length < 2) S.groups.files = { state: "short", asked: true };
      else askFiles(q, 0);
    }
    // When nothing in view waits on the gateway, this is what settles the announcement.
    settle();
  }

  function askMessages(q) {
    unsay();
    S.groups.messages = { state: "searching", asked: true };
    lane("messages", (free) =>
      send("messages", { query: q, scope: { excludeCron: true, excludeSubagents: true }, limit: 25 }, MESSAGE_DELAY, () => (src.has("msgfail") && TEST.requests.filter((r) => r.source === "messages").length === 1 ? { error: "the gateway didn't answer in time" } : gatewayMessages(q)), (reply, current) => {
        free();
        if (!current) return;
        if (reply.error) S.groups.messages = { state: "failed", asked: true, error: reply.error === "timeout" ? "the gateway didn't answer in 8 seconds" : reply.error };
        else {
          S.groups.messages = { state: "done", asked: true, reply, listed: new Set(reply.results.map((r) => r.sessionKey).filter((k) => listRow(k))) };
          // gone=task and gone=bot: the place leaves the device's lists after the results came.
          if (p("gone") === "task") S.removed.add(keyOf("otto", "o1"));
          if (p("gone") === "bot") S.botsGone.add("otto");
          if (p("gone") === "reset") taskOf("otto", "o1").sessionId = "s-o1-new";
          if (p("each") === "1" && reply.truncated) return searchEach(q, 0);
        }
        settle();
      }),
    );
  }

  // Routine pages: the first page's snapshotRevision is kept, and each later page is asked at the
  // nextOffset of the last accepted reply; a later page with another revision or an unexpected
  // offset stops paging, keeping the pages already accepted.
  function askRoutines(q, offset) {
    const prev = S.groups.routines;
    if (offset === 0) S.groups.routines = { state: "searching", asked: true };
    else {
      S.groups.routines = { ...prev, more: "loading" };
      prev.used.add(offset);
    }
    unsay();
    render();
    lane("routines", (free) =>
      send("routines", { query: q, enabled: "all", limit: ROUTINE_PAGE, offset }, 180, () => {
        if (src.has("routinesfail") && offset === 0 && TEST.requests.filter((r) => r.source === "routines").length === 1) return { error: "the gateway refused the request" };
        if (src.has("routinesmorefail") && offset > 0 && !S.retriedMore) return { error: "the gateway didn't answer in time" };
        const ql = q.toLowerCase();
        const all = ROUTINES.filter((r) => [r.id, r.name, r.description, r.bot, botName(r.bot)].join(" ").toLowerCase().includes(ql));
        const total = all.length;
        const jobs = all.slice(offset, offset + ROUTINE_PAGE);
        const nextOffset = offset + jobs.length < total ? offset + jobs.length : null;
        // routineschanged: a routine is edited between pages, so the revision moves and the total stays.
        const revision = src.has("routinesnorev") ? {} : { snapshotRevision: src.has("routineschanged") && offset > 0 ? "rev-2" : "rev-1" };
        return { jobs, total, offset, hasMore: nextOffset !== null, nextOffset, ...revision };
      }, (reply, current) => {
        free();
        if (!current) return;
        if (offset === 0) {
          S.groups.routines = reply.error ? { state: "failed", asked: true, error: reply.error === "timeout" ? "the gateway didn't answer in 8 seconds" : reply.error } : { state: "done", asked: true, rows: reply.jobs, total: reply.total, hasMore: reply.hasMore, nextOffset: reply.nextOffset, revision: reply.snapshotRevision, pages: 1, used: new Set([0]) };
        } else {
          const g = S.groups.routines;
          if (reply.error) g.more = { error: reply.error === "timeout" ? "the gateway didn't answer in 8 seconds" : reply.error };
          else if (reply.snapshotRevision !== g.revision || reply.offset !== offset) Object.assign(g, { more: "changed", hasMore: false });
          else Object.assign(g, { rows: [...g.rows, ...reply.jobs], hasMore: reply.hasMore, nextOffset: reply.nextOffset, pages: g.pages + 1, more: null });
        }
        settle();
      }),
    );
  }

  // Files: the eligible bots in roster order, a batch of 8 per query, 4 in flight.
  function filesEligible() {
    return roster().map((b) => {
      const ws = WORKSPACES[b.id];
      const via = ws?.via ? taskOf(b.id, ws.via) : null;
      // The workspace is established only through a task whose row carries none of the root fields.
      const verified = via && !via.roots;
      return { bot: b.id, via: verified ? via : null };
    });
  }

  function askFiles(q, from) {
    const g = from === 0 ? (S.groups.files = { state: "searching", asked: true, per: {}, order: filesEligible() }) : S.groups.files;
    const asked = g.order.filter((e) => e.via && !g.per[e.bot]).slice(0, FILES_CAP);
    for (const e of asked) g.per[e.bot] = { state: "searching" };
    // With no eligible bot nothing is sent, and the batch settles at once.
    if (!asked.length) {
      g.state = "done";
      return settle();
    }
    g.state = "searching";
    unsay();
    render();
    filesLane(asked.map((e) => ({ gen: S.gen, run: (free) => askFilesFor(q, e, free) })));
  }

  // Files has one lane: a batch, a single bot's retry and the latest query's batch all go through
  // it, and at most POOL requests are out at once, whichever query sent them. Work not yet sent is
  // dropped when the text changes; each request sent has its own 8 s deadline.
  const FILES = { out: 0, queue: [] };
  function filesLane(jobs) {
    FILES.queue.push(...jobs);
    pumpFiles();
  }
  function pumpFiles() {
    while (FILES.out < POOL && FILES.queue.length) {
      const job = FILES.queue.shift();
      if (job.gen !== S.gen) continue;
      FILES.out++;
      job.run(() => {
        FILES.out--;
        setTimeout(pumpFiles, 0);
      });
    }
  }

  function askFilesFor(q, e, free) {
    const g = S.groups.files;
    const ws = WORKSPACES[e.bot] || { root: `/srv/openclaw/workspaces/${e.bot}`, entries: [["AGENTS.md", "file"], [`notes/backup-plan-${e.bot}.md`, "file"]] };
    g.per[e.bot] = { state: "searching" };
    send("files", { sessionKey: keyOf(e.bot, e.via.id), search: q }, 260, () => {
      if (src.has("filesfail") && e.bot === "pip" && !S.filesRetried) return { error: "the gateway refused the request" };
      if (src.has("filesnoroot") && e.bot === "juniper") return { files: [] };
      if (src.has("filestimeout") && e.bot === "juniper" && !S.filesRetried) return { error: "timeout" };
      const entries = ws.entries.filter(([path]) => path.toLowerCase().includes(q.toLowerCase())).map(([path, kind]) => ({ path, kind }));
      return { root: ws.root, files: [], browser: { path: "", search: q, entries, ...(src.has("filescap") && e.bot === "otto" ? { truncated: true } : {}) } };
    }, (reply, current) => {
      free();
      if (!current) return;
      // An ordinary local task: the gateway's workspace binding and the root it returned.
      if (reply.error) g.per[e.bot] = { state: reply.error === "timeout" ? "timeout" : "refused", error: reply.error };
      else if (!reply.root) g.per[e.bot] = { state: "noroot" };
      // Only file entries; a folder whose name matches is not a file result.
      else g.per[e.bot] = { state: "done", root: reply.root, via: e.via.id, sessionId: e.via.sessionId, rows: reply.browser.entries.filter((x) => x.kind === "file").map((x) => x.path), truncated: Boolean(reply.browser.truncated) };
      if (!Object.values(g.per).some((v) => v.state === "searching")) g.state = "done";
      settle();
    });
  }

  // A bounded pool: `items` asked `POOL` at a time, in order, within the current generation.
  function pool(source, items, ask1) {
    const gen = S.gen;
    const queue = [...items];
    let running = 0;
    const pump = () => {
      while (gen === S.gen && running < POOL && queue.length) {
        running++;
        ask1(queue.shift(), () => {
          running--;
          setTimeout(pump, 0);
        });
      }
    };
    pump();
  }

  // Search each bot for more: one request per bot, 24 bots per action, 4 in flight. The rows of the
  // first search stay until every asked bot has answered or failed.
  function searchEach(q, from) {
    const g = S.groups.messages;
    const R = roster();
    const each = (g.each ||= { per: {}, asked: [] });
    const batch = R.filter((b) => !each.asked.includes(b.id)).slice(0, EACH_CAP);
    each.asked.push(...batch.map((b) => b.id));
    for (const b of batch) each.per[b.id] = { state: "queued" };
    each.finished = false;
    render();
    pool("each", batch, (b, free) => askEachFor(q, b.id, free));
  }

  function askEachFor(q, botId, free) {
    const g = S.groups.messages;
    g.each.per[botId] = { state: "searching" };
    unsay();
    render();
    send("messages", { query: q, scope: { agentId: botId, excludeCron: true, excludeSubagents: true }, limit: 25 }, 60, () => (src.has("eachfail") && botId === "pip" && !S.eachRetried ? { error: "the gateway didn't answer in time" } : gatewayMessages(q, botId)), (reply, current) => {
      free();
      if (!current) return;
      g.each.per[botId] = reply.error ? { state: "failed", error: reply.error === "timeout" ? "the gateway didn't answer in 8 seconds" : reply.error } : { state: "done", reply };
      const states = Object.values(g.each.per).map((v) => v.state);
      if (!states.some((s) => s === "searching" || s === "queued")) g.each.finished = true;
      // What it found is said with the rest, from the group's own coverage, once nothing is pending.
      settle();
    });
  }

  // The groups, in order, ready to draw ----------------------------------------------------------------------

  function messageRow(r, reply) {
    // The reply's role says only that a user sent it, not who: never "You".
    const who = r.role === "user" ? "User" : botName(r.bot);
    const title = listRow(r.sessionKey)?.title || reply.sessions?.find((s) => s.key === r.sessionKey)?.label || "Untitled task";
    return {
      kind: "message",
      key: `msg:${r.sessionKey}:${r.messageId}`,
      hit: r,
      bot: r.bot,
      first: `<span class="s-title">${esc(title)}</span> · ${esc(who)} · <span class="s-time">${esc(when(r.timestamp))}</span>`,
      // The snippet as the gateway sent it, as text, with no marks: the reply gives no ranges.
      second: esc(r.snippet.replace(/\s+/g, " ")),
      clamp: true,
      name: `Message in ${title}, from ${r.role === "user" ? "a user" : botName(r.bot)}, ${when(r.timestamp)}: ${r.snippet}`,
    };
  }
  const byTime = (rows) => [...rows].sort((a, b) => b.timestamp - a.timestamp);
  const flags = (reply) => [reply.indexing ? "Some messages are still being indexed." : "", reply.archivedTranscriptsExcluded ? `${plural(reply.archivedTranscriptsExcluded, "task has", "tasks have")} archived transcript content that wasn't searched.` : ""].filter(Boolean);

  function messagesGroup(q) {
    const gm = S.groups.messages || { state: "searching" };
    const g = { id: "messages", name: "Messages", rows: [], lines: [], actions: [], state: gm.state, complete: false, none: "User messages and bot replies in tasks this gateway lets you see", say: "" };
    if (gm.state === "failed") {
      g.lines.push(`Couldn't search messages: ${gm.error}.`);
      g.tone = "danger";
      g.say = "Messages couldn't be searched.";
      g.actions.push({ key: "act:retry-messages", label: "Try again", act: () => askMessages(q) });
      return g;
    }
    if (gm.state !== "done") return g;
    const reply = gm.reply;
    const each = gm.each;
    if (!each || !each.finished) {
      g.rows = byTime(reply.results).map((r) => messageRow(r, reply));
      const n = reply.results.length;
      const f = flags(reply);
      if (reply.truncated) g.lines.push(`Showing the ${n} matches the gateway returned, newest first. More indexed messages match.`);
      else if (f.length) g.lines.push(`${plural(n, "match", "matches")} returned, newest first.`);
      else g.lines.push(n === 1 ? "The one matching message" : `All ${n} matching messages, newest first`);
      g.lines.push(...f);
      g.complete = !reply.truncated && !f.length;
      g.say = reply.truncated ? "More messages match." : f.join(" ");
      if (each) {
        const v = Object.values(each.per);
        const c = (s) => v.filter((x) => x.state === s).length;
        g.state = "searching";
        // A bot that failed is counted apart, never as answered.
        g.lines.unshift(`Searching ${plural(each.asked.length, "bot")}… ${c("done")} answered, ${c("failed") ? `${c("failed")} couldn't search, ` : ""}${c("searching")} in progress, ${c("queued")} queued.`);
      } else if (reply.truncated) g.actions.push({ key: "act:each", label: "Search each bot for more", act: () => searchEach(q, 0) });
      return g;
    }
    // Each bot's own reply, under its own line.
    const R = roster();
    const answered = each.asked.filter((id) => each.per[id].state === "done");
    const n = answered.reduce((sum, id) => sum + each.per[id].reply.results.length, 0);
    const head = `${answered.length} of ${each.asked.length} bots answered. ${plural(n, "message")} returned.`;
    g.lines.push(head);
    const notAsked = R.filter((b) => !each.asked.includes(b.id));
    if (notAsked.length) g.lines.push(`Not asked: ${list(notAsked.map((b) => b.name))}.`);
    g.sub = each.asked.map((id) => {
      const e = each.per[id];
      const name = botName(id);
      if (e.state === "searching" || e.state === "queued") return { id: `messages-${id}`, name, line: `${name} · searching…`, rows: [], actions: [], partial: true };
      if (e.state === "failed")
        return { id: `messages-${id}`, name, line: `${name} · couldn't search: ${e.error}`, tone: "danger", rows: [], actions: [{ key: `act:each-retry:${id}`, label: `Try again for ${name}`, act: () => { S.eachRetried = true; askEachFor(q, id, () => {}); } }] };
      const rows = byTime(e.reply.results).map((r) => messageRow(r, e.reply));
      const f = flags(e.reply);
      const line = e.reply.truncated
        ? `${name} · ${rows.length} returned. More match; add words to narrow them.${f.length ? ` ${f.join(" ")}` : ""}`
        : f.length
          ? `${name} · ${rows.length ? `${rows.length} returned` : "none returned"}. ${f.join(" ")}`
          : rows.length
            ? `${name} · all ${plural(rows.length, "match", "matches")}`
            : `${name} · no matches`;
      return { id: `messages-${id}`, name, line, rows, actions: [], partial: Boolean(e.reply.truncated || f.length) };
    });
    g.rows = g.sub.flatMap((s) => s.rows);
    const failed = g.sub.filter((s) => s.tone).map((s) => s.name);
    g.complete = !notAsked.length && !failed.length && g.sub.every((s) => !s.partial);
    // A bot being searched again keeps the group pending.
    g.pending = g.sub.some((s) => s.line.endsWith("searching…"));
    g.say = [head, failed.length ? `${list(failed)} couldn't be searched.` : "", notAsked.length ? `${plural(notAsked.length, "bot was", "bots were")} not asked.` : ""].filter(Boolean).join(" ");
    if (notAsked.length) g.actions.push({ key: "act:each-next", label: `Search the next ${plural(Math.min(EACH_CAP, notAsked.length), "bot")}`, act: () => searchEach(q, 0) });
    return g;
  }

  function filesGroup(q) {
    const gf = S.groups.files || { state: "searching" };
    const g = { id: "files", name: "Files", rows: [], lines: [], actions: [], state: gf.state, complete: false, none: "File names returned from workspaces the palette can verify. Some folders may be skipped", say: "" };
    if (gf.state === "short") {
      g.lines.push("Type 2 or more characters to search file names.");
      g.state = "note";
      g.say = "Files weren't searched: type 2 or more characters.";
      return g;
    }
    if (!gf.per) return g;
    const by = (s) => gf.order.filter((e) => gf.per[e.bot]?.state === s).map((e) => e.bot);
    const done = by("done");
    const R = gf.order;
    if (!R.length) g.lines.push("Not searched: the gateway's bots haven't loaded yet.");
    if (done.length) g.lines.push(`Names the gateway returned from the workspaces of ${list(done.map(botName))}. Some folders may be skipped.`);
    const empty = done.filter((id) => !gf.per[id].rows.length);
    if (empty.length) g.lines.push(`No file names returned from ${list(empty.map(botName))}.`);
    const capped = done.filter((id) => gf.per[id].truncated);
    for (const id of capped) g.lines.push(`${botName(id)}: the gateway stopped at its limit of 500 names or 5,000 entries walked.`);
    const unverified = R.filter((e) => !e.via).map((e) => e.bot);
    if (unverified.length) g.lines.push(`Not searched: ${list(unverified.map((id) => `${botName(id)}'s workspace`))} could not be verified.`);
    for (const id of by("noroot")) g.lines.push(`${botName(id)}: the gateway returned no workspace for its task, so nothing was searched.`);
    const retries = [];
    for (const id of [...by("refused"), ...by("timeout")]) {
      const v = gf.per[id];
      g.lines.push(v.state === "timeout" ? `${botName(id)}: the gateway didn't answer in 8 seconds.` : `${botName(id)}: the gateway refused the search: ${v.error}.`);
      g.tone = "danger";
      const entry = gf.order.find((e) => e.bot === id);
      retries.push({ key: `act:retry-files:${id}`, label: `Try again for ${botName(id)}`, act: () => { S.filesRetried = true; gf.state = "searching"; gf.per[id] = { state: "searching" }; unsay(); render(); filesLane([{ gen: S.gen, run: (free) => askFilesFor(q, entry, free) }]); } });
    }
    const notAsked = R.filter((e) => e.via && !gf.per[e.bot]);
    // The next batch and each retry are offered only once the lane's current batch has settled.
    const busy = by("searching").length > 0;
    if (busy) g.state = "searching";
    else g.actions.push(...retries);
    if (notAsked.length) {
      g.lines.push(`Not asked yet: ${list(notAsked.map((e) => botName(e.bot)))}.`);
      if (!busy) g.actions.push({ key: "act:files-next", label: `Search the next ${plural(Math.min(FILES_CAP, notAsked.length), "bot")}' files`.replace("bot' files", "bot's files"), act: () => askFiles(q, 1) });
    }
    if (R.length && done.length !== R.length) g.lines.push(`${done.length} of ${R.length} bots' workspaces searched.`);
    for (const id of done)
      for (const path of gf.per[id].rows) {
        const name = path.split("/").pop();
        const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : `${botName(id)}'s workspace`;
        g.rows.push({ kind: "file", key: `file:${id}:${path}`, bot: id, path, first: esc(name), second: `${esc(folder)} · ${esc(botName(id))}`, name: `File ${path}, ${botName(id)}` });
      }
    // An uncapped reply describes the names returned; some folders may be skipped, so Files is
    // never complete and always keeps its coverage line.
    g.complete = false;
    g.say = [
      !R.length ? "Files weren't searched: the gateway's bots haven't loaded yet." : "",
      R.length && done.length === R.length ? "Some folders may be skipped." : "",
      capped.length ? `The file search stopped at its limit for ${list(capped.map(botName))}.` : "",
      unverified.length || notAsked.length || by("noroot").length ? `${plural(R.length - done.length, "bot's workspace was", "bots' workspaces were")} not searched.` : "",
      g.tone ? "Some workspaces couldn't be searched." : "",
    ]
      .filter(Boolean)
      .join(" ");
    return g;
  }

  function routinesGroup(q) {
    const gr = S.groups.routines || { state: "searching" };
    const g = { id: "routines", name: "Routines", rows: [], lines: [], actions: [], state: gr.state, complete: false, none: "Routine names, descriptions and bot details", say: "" };
    if (gr.state === "failed") {
      g.lines.push(`Couldn't search routines: ${gr.error}.`);
      g.tone = "danger";
      g.say = "Routines couldn't be searched.";
      g.actions.push({ key: "act:retry-routines", label: "Try again", act: () => askRoutines(q, 0) });
      return g;
    }
    if (gr.state !== "done") return g;
    g.lines.push("Matches routine names, descriptions and bot details");
    const ql = q.toLowerCase();
    g.rows = gr.rows.map((r) => {
      const idOnly = r.id.toLowerCase().includes(ql) && ![r.name, r.description, r.bot, botName(r.bot)].join(" ").toLowerCase().includes(ql);
      return {
        kind: "routine",
        key: `routine:${r.id}`,
        routine: r.id,
        bot: r.bot,
        first: markFound(r.name, q),
        second: `${esc(botName(r.bot))} · ${r.enabled ? "On" : "Off"}${idOnly ? ` · Matched its id, ${esc(r.id)}` : ""}`,
        name: `Routine ${r.name}, ${botName(r.bot)}, ${r.enabled ? "on" : "off"}${idOnly ? `, matched its id ${r.id}` : ""}. Opens routine.`,
      };
    });
    if (gr.more === "changed") {
      g.lines.push("The list of routines changed while more were loading. Search again to see it from the start.");
      g.say = "The list of routines changed.";
    } else if (gr.more?.error) {
      g.lines.push(`Couldn't load more routines: ${gr.more.error}.`);
      g.tone = "danger";
      g.actions.push({ key: "act:more-retry", label: "Try again", act: () => { S.retriedMore = true; gr.used.delete(gr.nextOffset); askRoutines(q, gr.nextOffset); } });
      g.say = "More routines couldn't be loaded.";
    } else if (gr.more === "loading") {
      g.lines.push("Loading more…");
      g.pending = true;
    }
    else if (gr.hasMore) {
      g.lines.push(`First ${gr.rows.length} of ${gr.total}`);
      // Paging is offered only when the reply supplies a next offset not asked for yet.
      if (Number.isInteger(gr.nextOffset) && !gr.used.has(gr.nextOffset)) g.actions.push({ key: "act:more-routines", label: `Show ${plural(Math.min(ROUTINE_PAGE, gr.total - gr.rows.length), "more routine", "more routines")}`, act: () => askRoutines(q, gr.nextOffset) });
      g.say = "More routines match.";
    } else if (gr.pages > 1) g.lines.push(gr.revision === undefined ? `${plural(gr.rows.length, "routine result")} loaded` : `All ${plural(gr.total, "routine")}`);
    g.complete = !gr.hasMore && !gr.more;
    return g;
  }

  function groups() {
    const q = S.query.trim();
    const local = localGroups(q);
    const out = [local.bots, local.tasks, messagesGroup(q), filesGroup(q), local.links, routinesGroup(q), local.settings];
    for (const g of out) {
      if (g.state === "searching" && !g.lines.length) g.lines = ["Searching…"];
      if (g.state === "offline") {
        g.lines = [`Not searched: ${GATEWAY} isn't connected. Search runs again when it reconnects.`];
        g.rows = [];
        g.actions = [];
        g.say = `${g.name} weren't searched: the gateway isn't connected.`;
      }
      if (g.state !== "done") g.complete = false;
    }
    return out;
  }

  // Which groups a scope shows on the phone; a scope asks only for its own sources.
  const SCOPES = [
    ["all", "All"],
    ["messages", "Messages"],
    ["bots", "Bots"],
    ["groups", "Group Chats"],
    ["files", "Files"],
    ["routines", "Routines"],
  ];
  const inScope = (id) => !phone() || S.scope === "all" || (S.scope === "messages" && ["tasks", "messages", "links"].includes(id)) || S.scope === id;

  // One summary drives the list's end and the live region, so the two can't disagree.
  // No global title and no combined count while any group in view has limited coverage or a pending
  // request: an incomplete view names the sources that finished empty, then the limits of the rest.
  function summary(all, q) {
    // Group Chats always says its one line.
    if (phone() && S.scope === "groups") return { visible: [], pending: false, none: [], allClear: false, say: "Group chats aren't part of Clawtrate yet." };
    const visible = all.filter((g) => inScope(g.id));
    const pending = visible.some((g) => g.state === "searching" || g.pending);
    const total = visible.reduce((n, g) => n + g.rows.length, 0);
    const none = visible.filter((g) => g.complete && !g.rows.length);
    const incomplete = visible.filter((g) => !g.complete);
    const allClear = !pending && visible.length > 0 && !total && !incomplete.length;
    let say = "";
    if (!pending) {
      if (allClear) say = `No results for ${q}.`;
      else {
        const counts = visible.filter((g) => g.rows.length).map((g) => plural(g.rows.length, g.name.toLowerCase().replace(/s$/, ""), g.name.toLowerCase()));
        const parts = [total && !incomplete.length ? `${plural(total, "result")}: ${counts.join(", ")}.` : "", none.length ? `No matches in ${list(none.map((g) => g.name))}.` : ""];
        for (const g of incomplete) parts.push(g.say || `${g.name} were searched only in part.`);
        say = parts.filter(Boolean).join(" ");
      }
    }
    return { visible, pending, none, allClear, say };
  }

  // Drawing ---------------------------------------------------------------------------------------------

  let options = [];

  function render() {
    if (!S.open) return;
    const L = layer();
    const q = S.query.trim();
    options = [];
    const isPhone = phone();
    L.dataset.form = isPhone ? "phone" : "palette";
    if (!$("#s-field", L)) build(L);
    const f = $("#s-field", L);
    const body = $("#s-body", L);
    // Scroll and focus survive a group filling in.
    const scroll = body.scrollTop;
    const focusId = document.activeElement?.id;
    f.placeholder = isPhone ? "Search" : "Search bots, tasks, messages, files, links, routines and settings";
    $(".s-scopes", L).hidden = !isPhone;
    if (isPhone) {
      $(".s-scopes", L).innerHTML = SCOPES.map(([id, label]) => `<button type="button" role="tab" class="s-scope" id="s-scope-${id}" data-scope="${id}" aria-selected="${S.scope === id}" aria-controls="s-body" tabindex="${S.scope === id ? 0 : -1}">${label}</button>`).join("");
      body.setAttribute("role", "tabpanel");
      body.setAttribute("aria-labelledby", `s-scope-${S.scope}`);
    } else {
      body.setAttribute("role", "presentation");
      body.removeAttribute("aria-labelledby");
    }
    let html;
    if (isPhone && S.scope === "groups") html = `<p class="s-solo">Group chats aren't part of Clawtrate yet.</p>`;
    else if (!q) html = idle();
    else html = results(groups(), q, isPhone);
    body.innerHTML = html;
    CT.hydrate(body);
    body.scrollTop = scroll;
    if (focusId && focusId !== document.activeElement?.id && document.getElementById(focusId)) document.getElementById(focusId).focus({ preventScroll: true });
    if (!options.some((o) => o.key === S.active)) S.active = options[0]?.key || null;
    f.setAttribute("aria-expanded", String(options.length > 0));
    paintActive(false);
  }

  function build(L) {
    L.innerHTML =
      `<div class="s-scrim" data-s="scrim"></div>` +
      `<div class="s-palette" role="dialog" aria-modal="true" aria-label="Search">` +
      `<div class="s-top"><span class="s-glass">${icon("search")}</span>` +
      `<input id="s-field" class="s-field" type="text" role="combobox" aria-label="Search" aria-expanded="false" aria-controls="s-list" aria-autocomplete="list" autocomplete="off" spellcheck="false" maxlength="4096" enterkeyhint="search" />` +
      `<button type="button" class="button s-cancel" data-variant="quiet" data-s="cancel">Cancel</button></div>` +
      `<div class="s-scopes" role="tablist" aria-label="Search in"></div>` +
      `<div class="s-body" id="s-body"></div>` +
      `<p class="s-foot" aria-hidden="true"></p>` +
      `<p class="visually-hidden" id="s-live" role="status" aria-live="polite"></p>` +
      `<div class="s-confirm-layer" hidden></div></div>`;
    const f = $("#s-field", L);
    f.value = S.query;
    f.addEventListener("input", () => onInput(f.value));
    f.addEventListener("keydown", onKey);
  }

  function idle() {
    const n = S.loaded.size;
    const tasksCut = p("state") === "partial";
    const rows = [
      ["Bots", "Every bot this connection can see, by name."],
      ["Tasks", `Titles in this device's task list, which keeps up to 500 tasks${tasksCut ? ". It was cut short and holds the most recent tasks only" : ""}.`],
      ["Messages", "User messages and bot replies in tasks this gateway lets you see. Excludes routine runs, subagent tasks and archived tasks."],
      ["Files", "File names returned from workspaces the palette can verify. Some folders may be skipped."],
      ["Links", n ? `Links in the conversations loaded on this device: ${n} now.` : "Links in conversations you open. None is loaded now."],
      ["Routines", "Routine names, descriptions and bot details."],
      ["Settings", "The sections of Clawtrate's Settings."],
    ];
    return `<section class="s-idle" aria-labelledby="s-idle-title"><h2 class="s-group-name" id="s-idle-title">What search looks in</h2><dl>${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${esc(v)}</dd></div>`).join("")}</dl></section>`;
  }

  function results(all, q, isPhone) {
    const sum = summary(all, q);
    if (sum.allClear) {
      return (
        `<section class="s-none" aria-labelledby="s-none-title"><h2 id="s-none-title">No results for “${esc(q)}”</h2><dl>` +
        sum.visible.map((g) => `<div><dt>${g.name}</dt><dd>${esc(g.none)}${g.id === "messages" ? ". Messages match the words you type; the end of your query can match the start of a word." : "."}</dd></div>`).join("") +
        `</dl></section>`
      );
    }
    let html = `<div class="s-list" id="s-list" role="listbox" aria-label="Results">`;
    // A group is drawn when it has results or was not searched in full; it is never folded into "No matches".
    for (const g of sum.visible) if (g.rows.length || !g.complete) html += group(g, isPhone);
    html += `</div>`;
    if (!sum.pending && sum.none.length)
      html += `<section class="s-nomatch" aria-labelledby="s-nomatch-title"><h2 class="s-group-name" id="s-nomatch-title">No matches in ${list(sum.none.map((g) => g.name))}</h2><dl>${sum.none.map((g) => `<div><dt>${g.name}</dt><dd>${esc(g.none)}.</dd></div>`).join("")}</dl></section>`;
    return html;
  }

  function group(g, isPhone) {
    const limit = isPhone && S.scope === "all" ? 3 : 5;
    // On the phone there is no Settings scope, so All shows every Settings row.
    const full = S.shown.has(g.id) || (isPhone && S.scope !== "all") || (isPhone && g.id === "settings");
    const headId = `s-g-${g.id}`;
    const descId = `s-gd-${g.id}`;
    let html = `<div class="s-group" role="group" aria-labelledby="${headId}" aria-describedby="${descId}" data-group="${g.id}"${g.tone ? ` data-tone="${g.tone}"` : ""}>`;
    html += `<div class="s-group-head" role="presentation"><span class="s-group-name" id="${headId}">${g.name}${g.rows.length ? ` · ${g.rows.length}` : ""}</span>`;
    html += `<span class="s-group-lines" id="${descId}">${g.lines.map((l) => `<span class="s-line">${esc(l)}</span>`).join("")}</span></div>`;
    if (g.state === "searching" && !g.rows.length) html += `<div class="s-skeleton" aria-hidden="true"><span></span><span></span></div>`;
    if (g.sub) {
      for (const s of g.sub) {
        html += `<div class="s-sub" role="presentation"${s.tone ? ` data-tone="${s.tone}"` : ""}><span class="s-sub-line">${esc(s.line)}</span></div>`;
        const rows = full ? s.rows : s.rows.slice(0, limit);
        html += rows.map(row).join("");
        if (!full && s.rows.length > limit) html += action({ key: `act:all:${s.id}`, label: `Show all ${s.rows.length} of ${s.name}'s messages`, act: () => { S.shown.add(g.id); render(); } });
        html += s.actions.map(action).join("");
      }
    } else {
      const rows = full ? g.rows : g.rows.slice(0, limit);
      html += rows.map(row).join("");
      if (!full && g.rows.length > limit) {
        const noun = g.name.toLowerCase();
        const scope = { tasks: "messages", links: "messages", messages: "messages", bots: "bots", files: "files", routines: "routines" }[g.id];
        html += isPhone
          ? action({ key: `act:see:${g.id}`, label: `See all ${g.rows.length} ${noun}`, act: () => setScope(scope) })
          : action({ key: `act:all:${g.id}`, label: `Show all ${g.rows.length} ${noun}`, act: () => { S.shown.add(g.id); render(); } });
      }
    }
    html += (g.actions || []).map(action).join("");
    return html + `</div>`;
  }

  function hintFor(r) {
    if (r.kind === "file") return "";
    return { bot: "Open", task: "Open", message: "Go to message", link: "Go to message", routine: "Open routine", setting: "Open" }[r.kind];
  }

  function leading(r) {
    if (r.kind === "bot" || r.kind === "task" || r.kind === "message") return `<span class="avatar" data-bot="${esc(r.bot)}"></span>`;
    return `<span class="s-icon">${icon({ file: "file", link: "link", routine: "clock", setting: "settings" }[r.kind])}</span>`;
  }

  function row(r) {
    const id = `s-o-${options.length}`;
    options.push({ key: r.key, id, row: r });
    const blocked = blockedLine(r);
    const opening = S.opening && S.opening.key === r.key ? S.opening : null;
    const note = blocked || (opening && opening.note) || "";
    const name = r.name + (note ? `. ${note}` : "");
    const hint = blocked && r.kind !== "file" ? "Can't open" : hintFor(r);
    let html =
      `<div class="s-row" role="option" id="${id}" data-key="${esc(r.key)}" data-kind="${r.kind}" aria-selected="false" aria-label="${esc(name)}">` +
      `<span class="s-lead">${leading(r)}</span>` +
      `<span class="s-text"><span class="s-first">${r.first}</span>` +
      (r.address ? `<span class="s-address" data-refused="${Boolean(r.refused)}">${r.address}</span>` : "") +
      (r.second ? `<span class="s-second${r.clamp ? " s-clamp" : ""}">${r.second}</span>` : "") +
      (opening && opening.state === "opening" ? `<span class="s-note">Opening…</span>` : "") +
      (note ? `<span class="s-note" data-tone="${blocked ? "muted" : "warn"}">${esc(note)}</span>` : "") +
      `</span>` +
      (hint ? `<span class="s-hint">${esc(hint)}${r.kind === "link" && r.url ? `<span class="s-hint-more" data-s="handoff">⇧↵ Open in browser</span>` : ""}</span>` : "") +
      `</div>`;
    // On the phone a link's handoff is an option of its own, under the same address rule.
    if (r.kind === "link" && r.url && (phone() || IOS)) html += action({ key: `act:open-link:${r.key}`, label: "Open link", name: IOS ? `Open ${r.url} outside Clawtrate` : `Open ${r.url} in your browser`, act: () => handoff(r) });
    if (opening && opening.state === "older") html += action({ key: "act:latest", label: "Open the task at its latest", act: () => openLatest(r) });
    if (opening && opening.state === "failed") html += action({ key: "act:retry-open", label: "Try again", act: () => openRow(r) });
    return html;
  }

  function action(a) {
    const id = `s-o-${options.length}`;
    options.push({ key: a.key, id, act: a.act });
    return `<div class="s-row s-action" role="option" id="${id}" data-key="${esc(a.key)}" aria-selected="false"${a.name ? ` aria-label="${esc(a.name)}"` : ""}>${esc(a.label)}</div>`;
  }

  function paintActive(scroll = true) {
    const L = layer();
    for (const el of $$(".s-row", L)) el.setAttribute("aria-selected", String(el.dataset.key === S.active));
    const opt = options.find((o) => o.key === S.active);
    const f = $("#s-field", L);
    if (opt) {
      f.setAttribute("aria-activedescendant", opt.id);
      if (scroll) $(`#${opt.id}`, L)?.scrollIntoView({ block: "nearest" });
    } else f.removeAttribute("aria-activedescendant");
    const foot = $(".s-foot", L);
    if (foot) foot.textContent = `↑↓ Move · ↵ Open · Esc Close${opt?.row?.kind === "link" && opt.row.url ? " · ⇧↵ Open in browser" : ""}`;
  }

  // What cannot open, and why (section 9). Each case is decided from the device's lists now and
  // the identity the reply returned, never from an empty history.
  function blockedLine(r) {
    if (r.kind === "file") return FILE_LINE;
    if (!["message", "link"].includes(r.kind)) return "";
    if (!roster().some((b) => b.id === r.bot)) return `${botName(r.bot)} is no longer in this connection's list of bots.`;
    const id = r.kind === "message" ? r.hit : r;
    const row = listRow(id.sessionKey);
    if (!row) {
      const wasListed = S.groups.messages?.listed?.has(id.sessionKey) || r.kind === "link";
      if (!wasListed) return "This task isn't in this device's task list, which keeps up to 500 tasks.";
      return S.opening?.key === r.key || S.tried?.has(r.key) ? "This task is no longer in this device's task list." : "";
    }
    if (row.sessionId !== id.sessionId) return S.opening?.key === r.key || S.tried?.has(r.key) ? "This task's conversation was replaced since the search. Search again." : "";
    return "";
  }

  // Opening a result in its place --------------------------------------------------------------------------------

  function openRow(r) {
    (S.tried ||= new Set()).add(r.key);
    // Every file result returns here, on the desktop and the iPhone: it says why, and nothing opens.
    if (blockedLine(r)) {
      render();
      return announce(blockedLine(r), S.gen);
    }
    if (r.kind === "bot") {
      close(false);
      app.selectBot(r.bot);
      return said(`Opened ${botName(r.bot)}.`);
    }
    if (r.kind === "task") {
      close(false);
      app.openTask(r.bot, r.task);
      return said(`Opened ${taskOf(r.bot, r.task).title}.`);
    }
    if (r.kind === "routine") {
      // Back returns to the conversation search was opened over (automation.md §6).
      const back = `search.html?bot=${encodeURIComponent(app.model.selectedBot)}&task=${encodeURIComponent(app.model.selectedTask || "")}${carry()}`;
      location.href = `routines.html?view=routine&routine=${encodeURIComponent(r.routine)}&return=${encodeURIComponent(back)}${carry()}`;
      return;
    }
    if (r.kind === "setting") {
      location.href = `controls.html?open=settings&section=${encodeURIComponent(r.section)}${carry()}`;
      return;
    }
    // A message, or the message that holds a link: the task's loaded rows are read for the returned
    // message id while the current conversation stays selected.
    const hit = r.kind === "message" ? r.hit : { ...r, timestamp: MESSAGES.find((m) => m.id === r.messageId)?.ts };
    const gen = S.gen;
    const token = ++S.openToken;
    S.opening = { key: r.key, state: "opening", token };
    render();
    setTimeout(() => {
      if (gen !== S.gen || S.opening?.token !== token) return;
      if (p("historyfail") === "1" && !S.historyRetried) {
        S.historyRetried = true;
        S.opening = { key: r.key, state: "failed", token, note: "Couldn't load this conversation: the gateway didn't answer in time." };
        render();
        return announce(S.opening.note, gen);
      }
      const held = new DOMParser().parseFromString(taskOf(hit.bot, hit.task)?.html ?? "", "text/html");
      if (!held.querySelector(`.turn[data-message-id="${CSS.escape(hit.messageId)}"]`)) {
        const w = windowOf(hit.task);
        const earlier = w.hasMore && w.rows >= 200 && hit.timestamp < w.oldest;
        S.opening = { key: r.key, state: "older", token, note: earlier ? "This message is earlier than the 200 messages this conversation shows, so it can't be shown in place." : "This message isn't in the conversation's loaded messages." };
        render();
        return announce(S.opening.note, gen);
      }
      if (!commit(r, hit, gen)) return;
      goToMessage($(`#transcript .turn[data-message-id="${CSS.escape(hit.messageId)}"]`), hit);
    }, 260);
  }

  // Selecting a result's task: only in the generation it was opened in, and only once the task list
  // still holds the result's task and session; then search closes and the task opens.
  function commit(r, hit, gen) {
    if (gen !== S.gen) return false;
    const blocked = blockedLine(r);
    if (blocked) {
      S.opening = null;
      render();
      announce(blocked, gen);
      return false;
    }
    close(false);
    app.openTask(hit.bot, hit.task);
    S.loaded.add(`${hit.bot}:${hit.task}`);
    return true;
  }
  // "Open the task at its latest" makes the same checks, then selects the task.
  const openLatest = (r) => commit(r, r.kind === "message" ? r.hit : r, S.gen);

  const carry = () => ["theme", "width", "motion", "chrome", "platform"].map((k) => (p(k) ? `&${k}=${p(k)}` : "")).join("");

  function goToMessage(turn, hit) {
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
    const task = taskOf(hit.bot, hit.task);
    said(`Opened ${task.title}, at ${hit.role === "user" ? "the user message" : `${botName(hit.bot)}'s reply`} of ${when(hit.timestamp)}.`);
  }

  // Handing a link to the system: directly when its canonical address is shown in full beside the
  // control, otherwise after the confirmation; an address on this device or the person's own
  // network always confirms.
  function handoff(r) {
    if (!r.url) return;
    const el = $(`.s-row[data-key="${CSS.escape(r.key)}"] .s-address`, layer());
    const full = el && el.textContent === r.url && el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1 && inView(el);
    if (full && !r.where) return handOver(r.url);
    confirmLink(r);
  }
  // The whole address line lies inside the visible bounds of the results and of the window.
  function inView(el) {
    const a = el.getBoundingClientRect();
    const v = $("#s-body", layer()).getBoundingClientRect();
    return a.top >= Math.max(v.top, 0) - 0.5 && a.bottom <= Math.min(v.bottom, innerHeight) + 0.5 && a.left >= Math.max(v.left, 0) - 0.5 && a.right <= Math.min(v.right, innerWidth) + 0.5;
  }
  function handOver(url) {
    TEST.handoffs.push({ url, confirmed: Boolean(S.confirm) });
    close(true);
    said(`In the app, ${url} ${IOS ? "opens outside Clawtrate" : "opens in your browser"}. This prototype opens nothing.`);
  }

  // The confirmation belongs to the generation it was shown in: a change to the text or the
  // connection cancels it, and Open hands over only while that generation is current.
  function confirmLink(r) {
    S.confirm = { url: r.url, gen: S.gen };
    const host = canonical(r.url).host;
    const L = $(".s-confirm-layer", layer());
    L.hidden = false;
    L.innerHTML =
      `<div class="s-confirm" role="alertdialog" aria-modal="true" aria-labelledby="s-confirm-title" aria-describedby="s-confirm-text">` +
      `<h2 id="s-confirm-title">Open this link?</h2>` +
      `<div id="s-confirm-text"><p class="s-confirm-host">${esc(host)}</p><p class="s-confirm-address">${esc(r.url)}</p>` +
      `<p class="s-confirm-line">${OPENS}${r.where ? ` ${LOCAL_LINE[r.where]}` : ""}</p></div>` +
      `<div class="s-confirm-actions"><button type="button" class="button" data-s="confirm-cancel">Cancel</button><button type="button" class="button" data-variant="primary" data-s="confirm-open">Open</button></div></div>`;
    $(".s-palette", layer()).setAttribute("data-confirm", "open");
    // The rest of the palette is inert while the confirmation is open.
    for (const el of $$(".s-palette > :not(.s-confirm-layer)", layer())) el.inert = true;
    $('[data-s="confirm-cancel"]', L).focus();
  }
  function closeConfirm(opened) {
    const c = S.confirm;
    if (opened && c?.gen === S.gen) return handOver(c.url);
    const L = $(".s-confirm-layer", layer());
    L.hidden = true;
    L.innerHTML = "";
    S.confirm = null;
    $(".s-palette", layer()).removeAttribute("data-confirm");
    for (const el of $$(".s-palette > *", layer())) el.inert = false;
    $("#s-field").focus();
  }
  // What the palette's live region published belongs to the query and connection it was said for.
  const unsay = () => {
    const live = $("#s-live");
    if (live) live.textContent = "";
  };

  // Input and keys ------------------------------------------------------------------------------------------

  // Any change to the text starts a new generation at once: nothing asked or opened before it can
  // reach the screen, and the device's groups refilter now; the gateway is asked after 250 ms.
  function onInput(value) {
    if (S.confirm) closeConfirm(false);
    unsay();
    S.query = value;
    S.gen++;
    S.opening = null;
    S.tried = null;
    clearTimeout(S.timer);
    clearTimeout(S.announceTimer);
    // A request still waiting for its lane belongs to the text before this change.
    for (const l of Object.values(S.lanes)) l.waiting = null;
    FILES.queue = [];
    const q = value.trim();
    S.groups = {};
    if (q) {
      for (const id of ["messages", "files", "routines"]) if (asks(id)) S.groups[id] = offline() ? { state: "offline" } : { state: id === "files" && q.length < 2 ? "short" : "searching" };
    }
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
    // Shift+Enter belongs to link results only.
    if (shift) return opt.row?.kind === "link" && opt.row.url ? handoff(opt.row) : undefined;
    if (opt.act) return opt.act();
    openRow(opt.row);
  }

  function onKey(event) {
    if (event.key === "ArrowDown") return event.preventDefault(), move(1);
    if (event.key === "ArrowUp") return event.preventDefault(), move(-1);
    if (event.key === "PageDown") return event.preventDefault(), moveGroup(1);
    if (event.key === "PageUp") return event.preventDefault(), moveGroup(-1);
    if (event.key === "Enter") {
      event.preventDefault();
      // The iPhone's Search key hides the keyboard; it does not open anything.
      if (SOFT_KEYBOARD) return event.target.blur();
      return activate(event.shiftKey);
    }
  }

  function setScope(id) {
    S.scope = id;
    S.active = null;
    clearTimeout(S.announceTimer);
    unsay();
    render();
    ask();
    $(`#s-scope-${id}`)?.focus();
  }

  // Opening and closing --------------------------------------------------------------------------------------

  // The background is inert while search is open.
  const background = () => [...$("#root").children].filter((el) => el.id !== "search-layer" && el.id !== "search-announce");

  function open(from) {
    if (S.open) {
      // With the link confirmation open, focus stays in it.
      if (S.confirm) return $(".s-confirm button")?.focus();
      $("#s-field").focus();
      $("#s-field").select();
      return;
    }
    S.open = true;
    S.opener = from || document.activeElement;
    const L = layer();
    L.hidden = false;
    L.innerHTML = "";
    for (const el of background()) el.inert = true;
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
    clearTimeout(S.announceTimer);
    S.query = ""; // the query goes with the palette
    S.groups = {};
    S.opening = null;
    S.tried = null;
    S.gen++;
    S.confirm = null;
    S.scope = "all";
    const L = layer();
    L.hidden = true;
    L.innerHTML = "";
    for (const el of background()) el.inert = false;
    $$('[data-action="search"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
    if (restoreFocus && S.opener && document.contains(S.opener)) S.opener.focus();
  }

  // The live region speaks only for the generation and the scope it was asked in.
  function announce(text, gen, scope = S.scope) {
    const live = $("#s-live");
    if (!live) return;
    live.textContent = "";
    setTimeout(() => {
      if (gen === S.gen && scope === S.scope && S.open) live.textContent = text;
    }, 30);
  }
  // The app's own announcer, after search closed: it speaks only while search stays closed, in the
  // generation it closed in.
  function said(text) {
    const el = $("#search-announce");
    el.textContent = "";
    const gen = S.gen;
    setTimeout(() => {
      if (gen === S.gen && !S.open) el.textContent = text;
    }, 30);
  }

  // Once every visible source has settled, say what the screen says (section 12).
  function settle() {
    render();
    clearTimeout(S.announceTimer);
    const gen = S.gen;
    const scope = S.scope;
    S.announceTimer = setTimeout(() => {
      if (!S.open || gen !== S.gen || scope !== S.scope) return;
      const sum = summary(groups(), S.query.trim());
      if (!sum.pending) announce(sum.say, gen, scope);
    }, 400);
  }

  // The app's extension ----------------------------------------------------------------------------------------

  CT.appExtension = {
    fixtures(bots) {
      const t = (bot, id) => bots.find((b) => b.id === bot)?.tasks.find((x) => x.id === id);
      for (const b of bots) for (const x of b.tasks) x.sessionId = `s-${x.id}`;
      // Marlow's only task works in a folder of its own.
      if (!bots.length) return; // the roster hasn't loaded (state=discovering)
      if (p("marlow") !== "workspace") t("marlow", "m1").roots = { spawnedCwd: "/srv/projects/newsletter" };
      // The conversations the message fixtures point into, with their rows' ids.
      const msgs = (task) => MESSAGES.filter((m) => m.task === task && m.turn !== undefined).sort((a, b) => a.turn - b.turn);
      for (const task of ["o3", "m1", "p1", "p3", "j2"]) {
        const x = bots.flatMap((b) => b.tasks).find((y) => y.id === task);
        if (!x) continue;
        const rows = msgs(task);
        if (task === "j2") rows.unshift({ id: "msg-j2-0", role: "user", text: x.ask || "Which e-book app does my library use?" });
        x.html = `<div class="stamp">${x.at > 0 ? "Today " : ""}${x.when}</div>` + rows.map((m) => turnHtml(m.role, m.id, esc(m.text))).join("");
        x.preview = rows.at(-1).text;
      }
      t("juniper", "j1").html = heatTranscript();
      // Otto's disk task: its four turns get their rows' ids, in order.
      const o1 = t("otto", "o1");
      let n = 0;
      const ids = ["msg-o1-0", "msg-o1-1", "msg-o1-2", "msg-o1-3"];
      if (typeof o1.html === "string") o1.html = o1.html.replace(/<div class="turn" /g, (m) => (n < ids.length ? `<div class="turn" data-message-id="${ids[n++]}" ` : m));
      // A roster large enough to reach the caps.
      for (let i = 0; i < EXTRA; i++) {
        const id = `b${String(i + 5).padStart(2, "0")}`;
        CT.botArt[id] = CT.botArt[`extra${(i % 4) + 1}`];
        const name = EXTRA_NAMES[i];
        bots.push({ id, name, label: "Helper", tasks: [{ id: `${id}t`, title: `${name}'s notes`, at: -5 - i, when: "Sun", preview: "Backup rotation noted.", unread: false, status: "idle", sessionId: `s-${id}t` }] });
        MESSAGES.push({ id: `msg-${id}`, bot: id, task: `${id}t`, turn: 0, role: "assistant", ts: at(5 + i, 10), text: `Backup rotation noted for ${name}.` });
        WORKSPACES[id] = { via: `${id}t`, root: `/srv/openclaw/workspaces/${id}`, entries: [["AGENTS.md", "file"], [`notes/backup-plan-${id}.md`, "file"]] };
      }
    },
    connectionChanged(name) {
      if (!S.open) return;
      // A change of connection starts a new generation; the latest query is asked once on return.
      if (S.confirm) closeConfirm(false);
      unsay();
      S.gen++;
      S.opening = null;
      clearTimeout(S.timer);
      clearTimeout(S.announceTimer);
      S.groups = {};
      S.lanes = {};
      if (offline()) {
        if (S.query.trim()) for (const id of ["messages", "files", "routines"]) S.groups[id] = { state: "offline" };
        settle();
      } else if (name === "connected") ask();
      else render();
    },
    ready(a) {
      app = a;
      // The rail's button: its tooltip names this platform's keys.
      $$('[data-action="search"]').forEach((b) => b.setAttribute("title", `Search (${MOD}K)`));
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
          const rowEl = event.target.closest(".s-row");
          if (rowEl) {
            S.active = rowEl.dataset.key;
            paintActive();
            activate(s === "handoff");
            if (S.open && !S.confirm && !phone()) $("#s-field")?.focus();
          }
        },
        true,
      );
      // Cmd/Ctrl+K anywhere, unless another modal dialog is open; Escape closes the top dialog.
      document.addEventListener(
        "keydown",
        (event) => {
          const command = MOD === "⌘" ? event.metaKey : event.ctrlKey;
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
          const scope = event.target.closest?.("[data-scope]");
          if (scope && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const ids = SCOPES.map(([id]) => id);
            const i = ids.indexOf(scope.dataset.scope);
            const next = event.key === "Home" ? 0 : event.key === "End" ? ids.length - 1 : Math.max(0, Math.min(ids.length - 1, i + (event.key === "ArrowRight" ? 1 : -1)));
            return setScope(ids[next]);
          }
          // Tab stays in the top dialog: the confirmation's buttons; the field on the desktop;
          // field, Cancel and the scope bar on the phone.
          if (event.key === "Tab") {
            event.preventDefault();
            const stops = S.confirm ? $$(".s-confirm button") : phone() ? [$("#s-field"), $(".s-cancel"), $(`#s-scope-${S.scope}`)] : [$("#s-field")];
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
