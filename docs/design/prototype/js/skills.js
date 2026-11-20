// Skills (docs/design/skills.md): the library in Settings, a skill's page and
// its saves, a new skill, removing and sharing, the skills a task has, a bot's
// skill filter and what it learned, and the cards of a bot saving a skill.
// On top of bots.js, bot-settings.js and t3.js. Nothing here talks to a
// gateway: "the gateway" is the object G below. A page shows only what it last
// read from G. A write is captured when it is chosen (what, on which skill or
// task, from which revision), answered later, and a page says what happened
// only from a read made after the answer (section 2, "Writes"). Every state
// comes from the address (skills.md, section 16).

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (text) =>
    String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { B, button, note, announce } = D;
  const BS = window.botSettings;
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const canWrite = () => B.access !== "read";
  const isAdmin = () => B.access === "admin";
  const online = () => ["connected", "synced"].includes(app.model.connection);
  let minute = 41;
  const clock = () => `5:${String(minute++).padStart(2, "0")} PM`;
  // A write's answer arrives after ANSWER ms (the address's `answer`, else 300), and the page's own read after READ ms more.
  const ANSWER = Number(p("answer")) || 300;
  const READ = 300;
  const later = (ms, f) => setTimeout(f, ms);
  // Every request the prototype sends, as sent: what a check reads to see what a click captured.
  const sent = [];

  // A revision is a hash of the whole SKILL.md and its files, as on the gateway (research section 3).
  const hash = CT.skillsFixtureHash;
  // SKILL.md from its parts. `extra` holds every frontmatter line other than name and
  // description, exactly as read; a save keeps them as they are (section 5).
  const markdown = (s) => s.raw || `---\nname: ${s.slug}\ndescription: ${s.description}\n${(s.extra || []).map((l) => `${l}\n`).join("")}---\n\n${s.body}\n`;
  const revOf = (s) => hash(markdown(s) + JSON.stringify((s.files || []).map((f) => f.path)));
  const commandName = (slug, id) => `s_${slug.replace(/-+/g, "_").slice(0, 9).replace(/_+$/, "")}_${hash(id).slice(0, 20)}`;
  const LIMIT = 1048576;
  const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
  const bytes = (t) => new TextEncoder().encode(t).length;

  // The gateway ----------------------------------------------------------------------------------

  const ME = "gateway-owner";
  const skill = (id, slug, description, body, extra = {}) => {
    const s = { id, slug, description, body, extra: [], owner: ME, ownerLabel: "Sam Lee", shared: false, enabled: true, removed: false, files: [], saved: "5:38 PM", ...extra };
    s.rev = revOf(s);
    s.name = commandName(slug, id);
    s.history = [{ rev: s.rev, md: markdown(s) }];
    return s;
  };
  const LONG = "a-very-long-skill-name-that-uses-all-sixty-three-characters-ok";
  const G = {
    profile: p("lib") === "noprofile" ? null : ME,
    multi: p("multi") === "1",
    skills: [
      skill("trail", "trail-checklist", "Use when planning a weekend walk, to check the weather, the route and what to pack.", "1. Check the forecast for the day of the walk.\n2. Choose the route and note its length.\n3. Pack water, a map and a warm layer.\n4. Note anything marked <important> on the map.", { saved: "2:51 PM" }),
      skill("kitchen", "kitchen-timer", "Use when timing a recipe.", "Run scripts/timer.sh with the minutes.\nRead references/times.md for common times.", {
        files: [
          { path: "references/times.md", size: "18 bytes", exec: false },
          { path: "scripts/timer.sh", size: "44 bytes", exec: true },
        ],
      }),
      skill("weather", "weather-check", "Use when asked about the weather for a walk.", "Call https://weather.example/forecast with curl and $WEATHER_API_KEY, then say the forecast in one line.", {
        extra: ["user-invocable: false", 'metadata: {"openclaw":{"requires":{"bins":["curl"],"env":["WEATHER_API_KEY"]}}}'],
        needs: { bins: ["curl"], env: ["WEATHER_API_KEY"] },
      }),
      skill("pack", "pack-list", "Use when packing for a trip of more than one night.", "Pack light. List what to bring by day, then cut a third.", { enabled: false }),
      skill("notes", "trip-notes", "Use when writing up a trip.", "Write the day, the route and one thing to change.", {
        raw: "---\nname: trip-notes\ndescription: >\n  Use when writing up a trip,\n  after you are home.\n---\n\nWrite the day, the route and one thing to change.\n",
      }),
      skill("ridge", "ridge-safety", "Use when a walk goes above the tree line.", "Turn back if the wind is too strong to stand still in.", { owner: null, ownerLabel: "Team", shared: true }),
    ],
    // Each bot's agents.entries.<id>.skills: undefined when the bot has no key of its own.
    lists: {},
    // agents.defaults.skills: undefined when the gateway sets none.
    defaults: p("defaults") === "none" ? [] : p("defaults") === "only" ? ["github", "tmux"] : undefined,
    learned: {
      juniper: [
        { name: "trail-checklist", description: "Use when planning a weekend walk, to check the weather, the route and what to pack.", files: ["SKILL.md"], live: true, versions: [] },
        // A live skill with a snapshot the workshop kept before a patch: listed with the archive, not archived.
        { name: "rest-stops", description: "Use when a walk is longer than three hours.", files: ["SKILL.md"], live: true, versions: [{ id: "20261119T141200000Z-patch", at: "2:12 PM" }] },
      ],
    },
    changes: {
      juniper: [
        { skill: "trail-checklist", action: "create", actor: "agent", task: "Weekend walk checklist", at: "3:04 PM" },
        { skill: "rest-stops", action: "create", actor: "review", at: "2:10 PM" },
      ],
    },
    mode: "auto",
  };
  if (p("longname") === "1") G.skills.push(skill("long", LONG, "Use when the name is as long as the gateway allows, so the screens have to wrap it.", "Say the name in full."));
  if (G.multi) G.skills.push(skill("river", "river-crossing", "Use when a trail crosses a river.", "Unbuckle the hip belt and face upstream.", { owner: "robin", ownerLabel: "Robin Park", shared: true }));
  for (const l of G.learned.juniper) l.text = `---\nname: ${l.name}\ndescription: ${l.description}\n---\n\nTake the steps the way they worked last time.\n`;
  const gw = (id) => G.skills.find((s) => s.id === id);
  // What skills.library.list returns to this connection: removed entries never; another
  // person's unshared one only to an admin (research section 1).
  // Whether this connection may read the entry at all: its own, shared, team-owned, or any to an admin.
  const readable = (s) => (G.profile !== null && s.owner === G.profile) || s.shared || s.owner === null || isAdmin();
  const visible = (s) => !s.removed && readable(s);
  // "Your skills": only with a profile, and only the entries that profile owns.
  const mine = (s) => G.profile !== null && s.owner === G.profile;
  // The gateway's canEdit for an entry: a writing connection that owns it, or an admin (research section 10).
  const gwCanEdit = (s) => canWrite() && (isAdmin() || (s.owner !== null && G.profile !== null && s.owner === G.profile));
  // An edit is offered only with write scope now, a durable profile, and the read's canEdit.
  const canEdit = (s) => canWrite() && G.profile !== null && Boolean(s.canEdit ?? gwCanEdit(s));
  // A read of one skill, as skills.library.read returns it, or what the gateway refuses.
  const read = (id) => {
    const s = gw(id);
    // Visibility first: an entry this connection can't read is not found, removed or not.
    if (!s || !readable(s)) return { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_NOT_FOUND" };
    if (s.removed) return { removed: true, slug: s.slug };
    return { canEdit: gwCanEdit(s), md: markdown(s), rev: s.rev, slug: s.slug, description: s.description, body: s.body, extra: [...s.extra], raw: s.raw, files: s.files.map((f) => ({ ...f })), shared: s.shared, enabled: s.enabled, saved: s.saved, owner: s.owner, ownerLabel: s.ownerLabel };
  };
  // Another device's save, on the gateway's side.
  function otherSave(id) {
    const s = gw(id);
    s.body = s.body.includes("Pack water, a map and a warm layer.") ? s.body.replace("Pack water, a map and a warm layer.", "Pack water, a map, a warm layer and a head torch.") : `${s.body}\nAnother device added this line.`;
    s.rev = revOf(s);
    s.saved = "5:44 PM";
    s.history.push({ rev: s.rev, md: markdown(s) });
  }
  // A save as the gateway does it: the submitted bundle on the submitted base.
  function commit(s, sub) {
    s.description = sub.description;
    s.body = sub.body;
    s.extra = [...sub.extra];
    s.files = sub.files.map((f) => ({ ...f }));
    const before = s.rev;
    s.rev = revOf(s);
    if (s.rev === before) return "unchanged";
    s.saved = clock();
    s.history.push({ rev: s.rev, md: markdown(s) });
    return "published";
  }

  // On the gateway: "gone" was removed; "elsewhere" was someone else's, no longer shared;
  // "hiddengone" was someone else's, unshared, and then removed.
  G.skills.push({ ...skill("gone", "old-route-notes", "Use when you note a route.", "Write down the route's turns."), removed: true });
  G.skills.push(skill("elsewhere", "shared-loop", "Use when walking the shared loop.", "Go anticlockwise.", { owner: "robin", ownerLabel: "Robin Park", shared: false }));
  G.skills.push({ ...skill("hiddengone", "robins-old-loop", "Use when walking Robin's old loop.", "Go clockwise.", { owner: "robin", ownerLabel: "Robin Park", shared: false }), removed: true });
  // An earlier revision of trail-checklist, kept in its history as every revision is.
  {
    const trail = gw("trail");
    const earlier = { ...trail, body: "1. Check the forecast.\n2. Pack water." };
    trail.history.unshift({ rev: revOf(earlier), md: markdown(earlier) });
  }
  const OLD_TRAIL = gw("trail").history[0].rev;
  const PINS = p("pins");
  // pins=full: a task with the 64 library skills the gateway allows.
  if (PINS === "full") for (let i = 0; i < 64; i += 1) G.skills.push(skill(`f${i}`, `walk-note-${i + 1}`, "Use when a walk needs a note.", "Write the note."));

  // A task's saved skills: each pin keeps its own revision, and that revision's text from the
  // skill's history. A revision the history doesn't have can't be pinned.
  const pinOf = (id, rev) => {
    const s = gw(id);
    const h = s?.history.find((entry) => entry.rev === (rev || s.rev));
    if (!h) return null;
    const x = CT.skillsParts(h.md);
    return { skillId: s.id, rev: h.rev, slug: s.slug, description: x.description, body: x.body };
  };
  const pins = {
    j1:
      PINS === "none"
        ? []
        : PINS === "full"
          ? Array.from({ length: 64 }, (_, i) => pinOf(`f${i}`))
          : [
              pinOf("trail", PINS === "outdated" || PINS === "removed" ? OLD_TRAIL : null),
              pinOf("kitchen"),
              pinOf("weather"),
              ...(PINS === "removed" ? [pinOf("gone"), pinOf("hiddengone")] : []),
              ...(PINS === "unavailable" || PINS === "entryfail" ? [pinOf("elsewhere")] : []),
            ],
    jlearn: [pinOf("kitchen"), pinOf("weather")],
    p1: [pinOf("ridge"), pinOf("kitchen")],
  };
  // pins=every: the task holds every skill this connection can attach.
  if (PINS === "every") pins.j1 = G.skills.filter((s) => visible(s)).map((s) => pinOf(s.id));
  // skills.status {agentId, sessionKey}: weather-check is not eligible for these tasks, and the
  // status reports it disabled; it names no missing requirement.
  const STATUS = { weather: { eligible: false, disabled: true, missing: null } };

  const listParam = p("list");
  const selected = app.model.selectedBot;
  if (listParam === "only") G.lists[selected] = [gw("trail").name, "weather"];
  if (listParam === "none") G.lists[selected] = [];
  if (listParam === "unknown") G.lists[selected] = [gw("trail").name, "s_old_route_9b1c2d3e4f5a6b7c8d9e"];
  if (p("learned") === "empty") G.learned.juniper = [];
  if (p("learned") === "nolive")
    for (const l of G.learned.juniper) (l.live = false), l.versions.unshift({ id: "20261119T145906550Z-archive", at: "3:10 PM" });
  if (p("learned") === "archived") {
    G.learned.juniper[0].live = false;
    G.learned.juniper[0].versions = [{ id: "20261119T145906550Z-archive", at: "3:10 PM" }];
    G.changes.juniper.unshift({ skill: "trail-checklist", action: "archive", actor: "user", at: "3:10 PM" });
  }
  // The gateway's own skills, from skills.status: names only.
  const GATEWAY_SKILLS = ["github", "healthcheck", "tmux", "weather"];

  // What the pages show ----------------------------------------------------------------------------

  const K = {
    lib: ["loading", "error", "empty", "many"].includes(p("lib")) ? p("lib") : "ready",
    readAt: "5:41 PM",
    page: p("skill") || null, // null, a skill's id, or "new"
    read: null, // the page's last read of the skill
    draft: null,
    mode: { save: p("save"), remove: p("remove"), share: p("share"), enable: p("enable"), task: p("taskw"), cfg: p("cfg"), card: p("cardw"), cardread: p("cardread"), learned: p("learnedw") },
    pending: null, // the word of a write waiting for its answer or its read: "Saving…"
    status: null, // what the last write's read showed
    compare: null, // {theirs}
    listStatus: null,
    tasks: {}, // per task key: its last read, pending write, outcome, held revision, attach menu
    pinState: PINS === "error" ? "error" : "ready",
    listDraft: null,
    listNote: null,
    listPending: false,
    learnedOpen: p("item") || null,
    learnedNote: null, // {bot, html}: a workshop write's result, shown only in its own bot's view
    learnedPending: null,
  };
  const takeMode = (kind) => {
    const m = K.mode[kind];
    K.mode[kind] = null;
    return m;
  };
  if (K.lib === "empty") G.skills = G.skills.filter((s) => !mine(s));
  if (K.lib === "many") for (let i = 0; i < 62; i += 1) G.skills.push(skill(`x${i}`, `route-note-${i + 1}`, "Use when a route needs a note.", "Write the note."));

  function openPage(id) {
    K.page = id;
    K.gone = false; // the page holds a draft of a skill a read showed removed
    K.status = null;
    K.compare = null;
    K.pending = null;
    if (id === "new") {
      K.read = null;
      K.draft = { slug: "", description: "", body: p("big") === "1" ? "é".repeat(LIMIT / 2) : "" };
      return;
    }
    const r = read(id);
    if (!r.rev) return;
    K.read = r;
    K.draft = { slug: r.slug, description: r.description, body: r.body };
    // save=conflict: another device saves this skill after the page read it.
    if (K.mode.save === "conflict") otherSave(id), (K.mode.save = null);
  }
  if (K.page) openPage(K.page);

  const dirty = () => {
    if (!K.draft) return false;
    if (K.page === "new") return Boolean(K.draft.slug || K.draft.description || K.draft.body);
    return K.draft.description !== K.read.description || K.draft.body !== K.read.body;
  };
  // The read SKILL.md with only the spans the person changed replaced (section 4): the exact
  // description scalar when Use when… changed, the exact body when Instructions changed.
  const editMarkdown = (r, d) => {
    const m = /^(---\n[\s\S]*?\n---\n\n?)([\s\S]*)$/.exec(r.md);
    let head = m[1];
    let body = m[2];
    if (d.description !== r.description) head = head.replace(/^(description: ).*$/m, (_, key) => key + d.description);
    if (d.body !== r.body) body = `${d.body}\n`;
    return head + body;
  };
  // What is checked against the limit: the bytes of the SKILL.md that would be sent.
  const serialized = (d) => (K.page !== "new" && K.read?.md ? editMarkdown(K.read, d) : markdown({ slug: d.slug || "x", description: d.description, body: d.body, extra: [] }));
  const sizeOf = (d) => bytes(serialized(d));
  // The gateway checks the parsed description's length in UTF-16 code units, not bytes.
  const DESC_MAX = 1024;
  const descCount = (d) => (d.description.length >= 900 ? `${d.description.length.toLocaleString("en-US")} of 1,024 characters.` : "");
  const problems = (d) => {
    const out = {};
    if (K.page === "new" && d.slug && !NAME.test(d.slug)) out.name = "Use lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.";
    if (K.page === "new" && !d.slug) out.nameMissing = true;
    if (!d.description.trim()) out.descMissing = true;
    if (/\n/.test(d.description)) out.desc = "Keep Use when… on one line.";
    if (d.description.length > DESC_MAX) out.desc = "Use when… is too long (maximum 1,024 characters).";
    if (!d.body.trim()) out.bodyMissing = true;
    if (sizeOf(d) > LIMIT) out.body = "SKILL.md can be at most 1,048,576 UTF-8 bytes, including the frontmatter.";
    return out;
  };
  const saveable = () => dirty() && !K.pending && !K.gone && online() && Object.keys(problems(K.draft)).length === 0;

  const rev = (r) => `<span class="k-rev mono" aria-label="Revision ${r}" title="${r}">${r.slice(0, 12)}</span>`;
  const tag = (word, tone = "") => `<span class="k-tag"${tone ? ` data-tone="${tone}"` : ""}>${word}</span>`;
  const fact = (k, v) => `<div><dt>${k}</dt><dd class="b-wrap-value">${v}</dd></div>`;
  const backTo = (label, action) => `<button type="button" class="icon-button b-back" data-k="${action}" aria-label="${label}">${icon("back")}</button>`;
  const writeBar = (need) =>
    `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${need}</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`;
  const CONTENT = `<div class="k-content">${icon("list")}<p><b>A skill supplies instructions to a bot.</b> A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it.</p></div>`;
  const statusNote = (html, tone = "") => (tone ? `<div role="status">${note(html, tone)}</div>` : `<div class="k-status" role="status">${icon("check")}<div>${html}</div></div>`);
  const pendingLine = (word) => `<p class="k-pending" role="status"><span class="status-dot" data-status="connecting"></span>${word}</p>`;

  // Settings, Skills (section 3) ------------------------------------------------------------------

  CT.botsSections.splice(CT.botsSections.findIndex(([id]) => id === "accounts") + 1, 0, ["skills", "Skills"]);
  CT.botsSectionViews = CT.botsSectionViews || {};
  CT.botsSectionViews.skills = ({ back }) => {
    if (K.page === "new") return newPage();
    if (K.page && gw(K.page)) return skillPage(gw(K.page));
    return libraryList(back);
  };

  function row(s) {
    const tags = [!s.enabled ? tag("Not in defaults") : "", mine(s) && s.shared ? tag("Shared") : "", s.owner === null ? tag("Team") : ""].join("");
    const from = mine(s) || s.owner === null ? "" : `<small class="k-from">From ${esc(s.ownerLabel)}${s.shared ? "" : ", not shared"}</small>`;
    const spoken = [s.slug, s.description, !s.enabled ? "not in defaults for new tasks" : "", mine(s) && s.shared ? "shared" : "", s.owner === null ? "team" : mine(s) ? "" : `from ${s.ownerLabel}`].filter(Boolean).join(", ");
    return `<li><button type="button" class="k-row" data-k-skill="${s.id}" aria-label="${esc(spoken)}"><span class="k-row-main"><span class="k-row-name">${esc(s.slug)}</span><span class="k-row-when">${esc(s.description)}</span>${from}</span><span class="k-tags">${tags}</span>${icon("chevron")}</button></li>`;
  }

  function libraryList(back) {
    const lead = "Skills in your library on this gateway, and skills others share here. A library skill reaches a bot only in a task that has it.";
    const head = `<div class="b-headrow"><p class="b-lead" style="margin:0;text-align:left">${lead}</p>${canWrite() && G.profile && K.lib === "ready" ? button("New skill", `data-k="new" data-size="sm"${online() ? "" : " disabled"}`) : ""}</div>`;
    const foot = canWrite() ? "" : writeBar("Changing skills needs write access.");
    if (K.lib === "loading") return { title: "Skills", back, body: head + `<div aria-busy="true" aria-label="Loading skills">${'<div class="skeleton" style="height:58px;width:100%;margin-top:10px"></div>'.repeat(3)}</div>`, foot };
    if (K.lib === "error")
      return { title: "Skills", back, body: head + `<div class="work-empty"><span class="empty-mark">${icon("warning")}</span><h4>Couldn't load your skills</h4><p>The gateway answered: Unable to complete the skill library operation. Review the bundle or retry the request.</p><div style="margin-top:10px">${button("Try again", 'data-k="lib-retry" data-size="sm"')}</div></div>`, foot };
    let body = head + (K.listStatus || "");
    if (!online()) body += note(`<p>Not connected to the gateway. This is the list as read at ${K.readAt}; nothing can be changed until the connection is back.</p>`, "warn");
    const own = G.skills.filter((s) => visible(s) && mine(s));
    const others = G.skills.filter((s) => visible(s) && !mine(s));
    if (!G.profile) body += note(`<p>This connection has no personal library: the gateway's list says it has no profile. Skills shared on this gateway are still listed.</p>`);
    else if (!own.length)
      body += `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>No skills yet</h4><p>A skill is a process you want a bot to follow, written once. Save one here, or ask a bot to save what it just did.</p>${canWrite() ? `<div style="margin-top:12px">${button("New skill", 'data-k="new"', "primary")}</div>` : ""}</div>`;
    else body += `<h4 class="b-group">Your skills</h4><ul class="k-rows">${own.map(row).join("")}</ul>`;
    if (others.length) body += `<h4 class="b-group">${isAdmin() ? "Others' skills on this gateway" : "Shared on this gateway"}</h4><ul class="k-rows">${others.map(row).join("")}</ul>`;
    const included = G.skills.filter((s) => visible(s) && s.enabled && (mine(s) || s.shared || s.owner === null)).length;
    body +=
      included > 64
        ? note(`<p>New sessions select up to 64 enabled skills, personal skills first and then stable ID order. In a session, detach a selected skill to make room and attach another from the library.</p>`, "warn")
        : `<p class="b-hint" id="k-defaults-hint">When an attributed person with a gateway profile creates a task, the gateway can pin up to 64 enabled library skills, their own first. Spawned tasks and tasks the gateway marks synthetic do not get these defaults. A save does not change an existing task's pins.</p>`;
    body += `<p class="b-hint k-readat">As read at ${K.readAt}. <button type="button" class="link-button" data-k="lib-read">Read again</button></p>`;
    return { title: "Skills", back, body, foot };
  }

  // A skill's page (sections 4, 5, 7, 8) -----------------------------------------------------------

  // Can the page change this skill's text without changing anything else in it? Only when
  // its description is one plain line it can write back the same way (section 5).
  const roundTrips = (r) => !r.raw;

  function fieldsHtml(editable) {
    const d = K.draft;
    const pr = problems(d);
    // During Remove the two fields are read-only until the result (section 2, Writes).
    const frozen = K.pending === "Removing…" ? " readonly" : "";
    if (!editable)
      return (
        `<div class="k-field"><span class="k-label">Use when…</span><p class="k-ro" id="k-desc-text">${esc(d.description)}</p></div>` +
        `<div class="k-field"><span class="k-label">Instructions</span><pre class="k-plain" id="k-body-text">${esc(d.body)}</pre></div>`
      );
    return (
      `<div class="k-field"><label class="k-label" for="k-desc">Use when…</label><input class="input" id="k-desc" data-k-field="description" value="${esc(d.description)}" aria-describedby="k-desc-help"${frozen} />` +
      `<p class="${pr.desc ? "b-field-error" : "b-hint"}" id="k-desc-help">${pr.desc || (pr.descMissing ? "Say when a bot should use this skill." : descCount(d) || "When a bot should use it. The gateway shows this to the bot.")}</p></div>` +
      `<div class="k-field"><label class="k-label" for="k-body">Instructions</label><textarea class="input k-editor" id="k-body" data-k-field="body" rows="12" spellcheck="false" aria-describedby="k-body-help"${frozen}>${esc(d.body)}</textarea>` +
      `<p class="${pr.body ? "b-field-error" : "b-hint"}" id="k-body-help">${pr.body || (pr.bodyMissing ? "Write what the bot should do." : "Plain text. Shown to the bot as written.")}</p></div>`
    );
  }

  function otherSettingsHtml(r) {
    if (!r.extra.length) return "";
    return `<h4 class="b-group">Its other settings</h4><pre class="k-plain" id="k-extra">${esc(r.extra.join("\n"))}</pre><p class="b-hint">Written in the skill by whoever made it. Saving keeps them exactly as they are; this page doesn't change them.</p>`;
  }
  function filesHtml(r) {
    if (!r.files.length) return "";
    return (
      `<h4 class="b-group">Files</h4><dl class="facts k-files">${r.files.map((f) => `<div><dt class="mono">${esc(f.path)}</dt><dd class="b-wrap-value">${esc(f.size)}${f.exec ? ` · ${tag("Can run as a program")}` : ""}</dd></div>`).join("")}</dl>` +
      `<p class="b-hint">Kept with every save. A bot runs a file only with the tools it is allowed. Editing files isn't in this version.</p>`
    );
  }
  function needsHtml(s) {
    if (!s.needs) return "";
    return `<h4 class="b-group">Needs</h4><p class="k-needs">Programs: <span class="mono">${s.needs.bins.map(esc).join(", ")}</span>. Values: <span class="mono">${s.needs.env.map(esc).join(", ")}</span>.</p><p class="b-hint">From the skill's own text. The gateway gives a skill to a bot only when what it needs is there.</p>`;
  }

  function skillPage(live) {
    const r = K.read;
    // The page acts on what it last read, not on the gateway's state since.
    const s = { ...live, owner: r.owner, shared: r.shared, canEdit: r.canEdit };
    const fits = roundTrips(r);
    const editable = canEdit(s) && fits;
    let body = CONTENT + (K.pending ? pendingLine(K.pending) : "") + (K.status || "");
    if (!online() && canEdit(s)) body += note(`<p>Not connected to the gateway. What you type stays here; Save waits for the connection.</p>`, "warn");
    if (K.compare) body += compareHtml(r);
    body += `<div class="k-field"><span class="k-label">Name</span><p class="k-name mono" id="k-name">${esc(r.slug)}</p><p class="b-hint">A skill's name is set when it is made in Clawtrate.</p></div>`;
    if (!fits)
      body +=
        note(`<p>Clawtrate can't change this skill's text without changing how it is written: its Use when… isn't on one line. It is shown as the gateway keeps it.</p>`) +
        `<pre class="k-plain" id="k-raw-md">${esc(r.raw)}</pre>`;
    else if (!K.compare) body += fieldsHtml(editable);
    body += otherSettingsHtml(r) + filesHtml(r) + needsHtml(s);
    const owner = G.profile !== null && r.owner === G.profile ? "You" : r.owner === null ? "Team" : esc(r.ownerLabel);
    body +=
      `<h4 class="b-group">On the gateway</h4><dl class="facts">` +
      fact("Owner", owner) +
      fact("Revision", rev(r.rev)) +
      fact("Updated", esc(r.saved)) +
      fact("Shared", r.shared ? "Shared on this gateway" : "Not shared") +
      (editable
        ? `<div class="b-row"><span class="b-row-main"><span>Include in defaults for new tasks</span><small id="k-enabled-line">${
            r.enabled ? "Eligible new tasks can start with this skill, subject to the 64-skill limit." : "Excluded from defaults. It can still be attached where the gateway offers it."
          }</small></span>` +
          `<button type="button" class="b-switch" role="switch" aria-checked="${r.enabled}" aria-label="Include in defaults for new tasks" aria-describedby="k-enabled-line" data-k="enable"${!K.pending && !K.gone && online() ? "" : " disabled"}></button></div>`
        : fact("Include in defaults for new tasks", r.enabled ? "Included" : "Not included")) +
      `</dl>`;
    if (mine(s) && editable) {
      body += r.shared
        ? `<p class="b-hint">Shared on this gateway: eligible profiles here can see it in their libraries. Tasks that have it keep it when you stop sharing.</p>`
        : `<p class="b-hint" id="k-share-line">Sharing makes it available to eligible profiles on this gateway: it is listed in their libraries, and their new tasks can begin with it while it is included in defaults. Nothing leaves the gateway.</p>`;
      body += `<p class="b-hint" id="k-share-saved">Both change sharing for this skill. The request checks the saved revision shown here.<span id="k-share-draft">${dirty() ? " Your unsaved text stays here." : ""}</span></p>`;
    }
    if (!mine(s) && !canEdit(s) && canWrite()) body += `<p class="b-hint">Only the skill's owner or a Gateway administrator can change it.</p>`;
    const foot = !canWrite()
      ? writeBar("Changing skills needs write access.")
      : editable && !K.compare
        ? `<div class="b-actions k-foot">${button(K.pending === "Saving…" ? "Saving…" : "Save", `data-k="save" data-size="sm"${saveable() ? "" : " disabled"}`, "primary")}<span class="spacer"></span>` +
          (mine(s) ? button(r.shared ? "Stop sharing" : "Share on this gateway", `data-k="share" data-size="sm"${K.pending || K.gone || !online() ? " disabled" : ""}`) : "") +
          button("Remove skill…", `data-k="remove" data-size="sm" data-tone="danger"${K.pending || K.gone || !online() ? " disabled" : ""}`, "quiet") +
          `</div>`
        : "";
    return { title: `<span class="k-title">${esc(r.slug)}</span>`, back: backTo("Back to skills", "to-list"), body, foot };
  }

  function compareHtml(r) {
    const t = K.compare.theirs;
    const kept = [t.extra.length ? "its other settings" : "", t.files.length ? `its ${t.files.length === 1 ? "file" : `${t.files.length} files`}` : ""].filter(Boolean).join(" and ");
    return (
      note(`<p><b>The gateway has a different revision</b>: ${rev(t.rev)}, as read at ${esc(K.compare.readAt || clock())}. Your edit isn't saved. Compare them, then choose.</p>`, "warn") +
      `<div class="k-compare-wrap"><div class="k-compare">` +
      `<section aria-labelledby="k-theirs"><h4 class="b-group" id="k-theirs">On the gateway now</h4><p class="b-hint">Revision ${rev(t.rev)}, saved ${esc(t.saved)}</p><p class="k-label">Use when…</p><p class="k-ro" data-k-theirs-desc>${esc(t.description)}</p><p class="k-label">Instructions</p><pre class="k-plain" data-k-theirs>${esc(t.body)}</pre></section>` +
      `<section aria-labelledby="k-mine"><h4 class="b-group" id="k-mine">Your edit</h4>${fieldsHtml(true)}</section>` +
      `</div></div>` +
      `<p class="b-hint">Theirs stays as an earlier revision on the gateway.${kept ? ` Saving yours keeps ${kept} as they are on the gateway now.` : ""}</p>` +
      `<div class="b-actions">${button("Save my edit", `data-k="save-mine" data-size="sm"${K.pending ? " disabled" : ""}`, "primary")}${button("Use theirs", 'data-k="use-theirs" data-size="sm"')}</div>`
    );
  }

  function newPage() {
    const d = K.draft;
    const pr = problems(d);
    let body = CONTENT + (K.pending ? pendingLine(K.pending) : "") + (K.status || "");
    if (!online()) body += note(`<p>Not connected to the gateway. What you type stays here; Save waits for the connection.</p>`, "warn");
    body +=
      `<div class="k-field"><label class="k-label" for="k-slug">Name</label><input class="input mono" id="k-slug" data-k-field="slug" maxlength="80" value="${esc(d.slug)}" autocomplete="off" spellcheck="false" aria-describedby="k-slug-help" data-b-focus${K.pending ? " readonly" : ""} />` +
      `<p class="${pr.name || K.nameTaken ? "b-field-error" : "b-hint"}" id="k-slug-help">${K.nameTaken ? `You already have a skill called ${esc(K.nameTaken)}. Choose another name.` : pr.name || "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters."}</p></div>`;
    body += fieldsHtml(true);
    const foot = `<div class="b-actions k-foot">${button(K.pending ? "Saving…" : "Save", `data-k="save" data-size="sm"${saveable() && !K.nameTaken ? "" : " disabled"}`, "primary")}</div>`;
    return { title: K.saveAsNew ? "Save text as a new skill" : "New skill", back: backTo("Back to skills", "to-list"), body, foot };
  }

  const settings = () => $("#settings-dialog");
  const rerender = () => D.renderSettings();
  // Typing updates only the field's help and Save, so the caret stays where it is.
  function refreshForm() {
    const d = K.draft;
    if (!d) return;
    const pr = problems(d);
    const save = $('[data-k="save"]', settings());
    if (save) save.disabled = !saveable() || Boolean(K.nameTaken && d.slug === K.nameTaken);
    const shareDraft = $("#k-share-draft", settings());
    if (shareDraft) shareDraft.textContent = dirty() ? " Your unsaved text stays here." : "";
    const set = (id, error, hint) => {
      const el = $(id, settings());
      if (!el) return;
      el.className = error ? "b-field-error" : "b-hint";
      el.textContent = error || hint;
    };
    set("#k-desc-help", pr.desc, pr.descMissing ? "Say when a bot should use this skill." : descCount(d) || "When a bot should use it. The gateway shows this to the bot.");
    set("#k-body-help", pr.body, pr.bodyMissing ? "Write what the bot should do." : "Plain text. Shown to the bot as written.");
    if (K.page === "new") set("#k-slug-help", K.nameTaken && d.slug === K.nameTaken ? `You already have a skill called ${K.nameTaken}. Choose another name.` : pr.name, "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.");
  }

  // Saving (section 5). What is sent is captured at the click: the skill, the base revision,
  // the two fields, and every other part of the skill as the base has it. The receipt and the
  // read that follows are kept apart, and the page concludes only what they establish.
  function save({ over = false } = {}) {
    if (K.pending) return;
    if (K.page === "new") return saveNew();
    const base = over ? K.compare.theirs : K.read;
    const sub = { id: K.page, base: base.rev, description: K.draft.description, body: K.draft.body, extra: [...base.extra], files: base.files.map((f) => ({ ...f })), content: editMarkdown(base, K.draft) };
    const mode = takeMode("save");
    sent.push({ method: "skills.library.save", skillId: sub.id, expectedRevision: sub.base, content: sub.content, retainFiles: sub.files.map((f) => f.path) });
    K.pending = "Saving…";
    K.status = null;
    rerender();
    announce("Saving");
    later(ANSWER, () => {
      const s = gw(sub.id);
      let answer;
      if (mode === "removed") s.removed = true;
      // hidden: the entry is still there, but this connection can no longer read it.
      if (mode === "hidden") Object.assign(s, { owner: "robin", ownerLabel: "Robin Park", shared: false });
      if (mode === "refused" || mode === "refusedmoved" || mode === "refusedreadfail") answer = { error: "INVALID_REQUEST", message: "Skill library authority changed. Refresh and retry." };
      else if (mode === "silent") answer = { error: "UNAVAILABLE" };
      else if (s.removed || mode === "hidden") answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_NOT_FOUND" };
      else if (s.rev !== sub.base) answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_CONFLICT", currentRevision: s.rev };
      else if (mode === "lostnot") answer = null; // the request never reached the gateway
      else {
        const state = commit(s, sub);
        answer = mode === "lost" ? null : { state, rev: s.rev };
        if (mode === "superseded") otherSave(sub.id);
        // rollback: another device moves the entry back to an earlier revision.
        if (mode === "rollback") rollback(s);
      }
      // refusedmoved: another device saves between the refusal and this page's read.
      if (mode === "refusedmoved") otherSave(sub.id);
      later(READ, () => settleSave(sub, answer, mode));
    });
  }
  function rollback(s) {
    const earlier = s.history[0];
    const back = CT.skillsParts(earlier.md);
    s.description = back.description;
    s.body = back.body;
    s.rev = earlier.rev;
    s.saved = clock();
  }

  function settleSave(sub, answer, mode) {
    K.pending = null;
    const typedSince = K.draft.description !== sub.description || K.draft.body !== sub.body;
    const r = mode === "readfail" || mode === "refusedreadfail" ? { error: "UNAVAILABLE" } : read(sub.id);
    const mineNow = typedSince ? `<p>You typed more after you chose Save. That text is still here, unsaved.</p>` : "";
    const readAgain = `<div class="b-actions">${button("Read again", 'data-k="reread" data-size="sm"')}</div>`;
    const asNew = `<div class="b-actions">${button("Save text as a new skill", 'data-k="save-as-new" data-size="sm"')}</div>`;
    const settle = (html, tone, said) => {
      K.status = statusNote(html + mineNow, tone);
      announce(said);
      rerender();
    };
    // Only a read that shows the tombstone says the skill was removed.
    if (r.removed === true) return settle(`<p>This skill was removed on the gateway. Your text is still here.</p>${asNew}`, "danger", "Couldn't save");
    if (answer?.code === "SKILL_LIBRARY_CONFLICT" && r.rev) {
      K.compare = { theirs: r, readAt: clock() };
      announce("The gateway has a different revision");
      rerender();
      return $("#k-theirs", settings())?.scrollIntoView({ block: "nearest" });
    }
    const refusal = !answer?.error
      ? ""
      : answer.error === "UNAVAILABLE"
        ? "The gateway answered that it couldn't complete the save, without saying why."
        : `The gateway answered: ${esc(answer.message || answer.code)}`;
    if (r.error) {
      if (answer?.code === "SKILL_LIBRARY_NOT_FOUND") return settle(`<p>Couldn't read this skill again. Your text is still here.</p>${asNew}`, "danger", "Couldn't read the skill again.");
      if (answer?.error) return settle(`<p>${refusal} Couldn't read the skill again. The page shows the last readable revision. Your text is still here.</p>${readAgain}`, "danger", "Couldn't read the skill again.");
      if (!answer) return settle(`<p>Couldn't tell whether your save reached the gateway, and reading the skill again failed too. Your text is still here.</p>${readAgain}`, "warn", "Couldn't read the skill again.");
      return settle(`<p>The gateway returned revision ${rev(answer.rev)} for your request. Reading the skill again failed. The page still shows the previous read.</p>${readAgain}`, "warn", "Couldn't read the skill again.");
    }
    if (answer?.error) {
      // The read is reported as found. A different revision is compared before another save.
      if (r.rev !== sub.base) K.compare = { theirs: r, readAt: clock() };
      else K.read = r;
      return settle(`<p>${refusal} The next read found revision ${rev(r.rev)}. Your text is still here.</p>`, "danger", "Couldn't save");
    }
    if (!answer) {
      // No answer: say only what the read shows, and keep the text.
      const matches = r.description === sub.description && r.body === sub.body;
      K.read = r;
      return settle(
        `<p>Couldn't tell whether your save reached the gateway. Reading the skill again found revision ${rev(r.rev)}, updated ${esc(r.saved)}; its text ${matches ? "matches" : "doesn't match"} what you sent. Which save wrote it isn't known. Your text is still here${matches ? "" : ", unsaved"}.</p>`,
        "warn",
        "Couldn't tell whether it was saved",
      );
    }
    K.read = r;
    if (!typedSince) K.draft = { slug: r.slug, description: r.description, body: r.body };
    K.compare = null;
    if (r.rev !== answer.rev) settle(`<p>The gateway returned revision ${rev(answer.rev)} for your save. The next read found revision ${rev(r.rev)}. The page shows ${rev(r.rev)}.</p>`, "warn", "The next read found a different revision");
    else if (answer.state === "unchanged") settle(`<p>The gateway already had this bundle at revision ${rev(answer.rev)}.</p>`, "", "Already saved");
    else
      settle(
        `<p>Saved revision ${rev(r.rev)}. Tasks that hold it keep their pins.</p>`,
        "",
        "Saved",
      );
    $("#b-section-title", settings())?.focus();
  }

  // A new skill (section 6). The receipt's skill ID is read; the name only when there was no answer.
  function saveNew() {
    const sub = { slug: K.draft.slug, description: K.draft.description, body: K.draft.body };
    const mode = takeMode("save");
    sent.push({ method: "skills.library.save", slug: sub.slug, expectedRevision: null });
    K.pending = "Saving…";
    K.status = null;
    rerender();
    announce("Saving");
    later(ANSWER, () => {
      const taken = G.skills.find((s) => !s.removed && mine(s) && s.slug === sub.slug);
      let answer;
      if (taken || mode === "taken") answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_NAME_CONFLICT" };
      else if (mode === "refused") answer = { error: "INVALID_REQUEST", message: "Skill library authority changed. Refresh and retry." };
      else if (mode === "lostnot") answer = null;
      else if (mode === "lostother") {
        // Another device made a skill with this name first; this request was refused, and its answer lost.
        G.skills.push(skill(`other-${sub.slug}`, sub.slug, "Use when another device wrote it.", "Another device's instructions.", { saved: clock() }));
        answer = null;
      } else {
        const s = skill(`new-${sub.slug}`, sub.slug, sub.description, sub.body, { saved: clock() });
        G.skills.push(s);
        answer = mode === "lost" ? null : { state: "published", entry: { skillId: s.id, slug: s.slug, revision: s.rev } };
        if (mode === "superseded") otherSave(s.id);
      }
      later(READ, () => {
        K.pending = null;
        const laterDraft = { ...K.draft };
        const typedSince = laterDraft.description !== sub.description || laterDraft.body !== sub.body;
        const mineNow = typedSince ? `<p>You typed more after you chose Save. That text is still here, unsaved.</p>` : "";
        const settle = (html, tone, said) => {
          K.status = statusNote(html + mineNow, tone);
          announce(said);
          rerender();
        };
        if (answer?.code === "SKILL_LIBRARY_NAME_CONFLICT") {
          K.nameTaken = sub.slug;
          announce("Couldn't save");
          rerender();
          return $("#k-slug", settings())?.focus();
        }
        if (answer?.error) return settle(`<p>The gateway answered: ${esc(answer.message)} Your text is still here.</p>`, "danger", "Couldn't save");
        if (!answer) {
          // Read the library again by name: what it finds may not be this request's.
          const found = G.skills.find((s) => !s.removed && mine(s) && s.slug === sub.slug);
          return found
            ? settle(`<p>Couldn't tell whether your save reached the gateway. Reading your library again found a skill named ${esc(sub.slug)}, revision ${rev(found.rev)}; whether your save made it isn't known.</p><div class="b-actions">${button("Open it", `data-k-skill="${found.id}" data-size="sm"`)}</div>`, "warn", "Couldn't tell whether it was saved")
            : settle(`<p>Couldn't tell whether your save reached the gateway. Reading your library again found no skill named ${esc(sub.slug)}. Your text is still here.</p>`, "warn", "Couldn't tell whether it was saved");
        }
        const id = answer.entry.skillId;
        const r = mode === "readfail" ? { error: "UNAVAILABLE" } : read(id);
        if (!r.rev)
          return settle(
            `<p>The gateway returned revision ${rev(answer.entry.revision)} for your request. Reading the skill again failed. Your text is still here.</p><div class="b-actions">${button("Read again", `data-k-skill="${esc(id)}" data-size="sm"`)}</div>`,
            "warn",
            "Couldn't read the skill again.",
          );
        // Confirmed by a read of the receipt's entry: the page becomes that skill's page.
        K.nameTaken = null;
        K.saveAsNew = false;
        openPage(id);
        if (typedSince) K.draft = { slug: r.slug, description: laterDraft.description, body: laterDraft.body };
        if (r.rev !== answer.entry.revision)
          settle(`<p>The gateway returned revision ${rev(answer.entry.revision)} for your save. The next read found revision ${rev(r.rev)}. The page shows ${rev(r.rev)}.</p>`, "warn", "The next read found a different revision");
        else settle(`<p>Saved revision ${rev(r.rev)}. Tasks that hold it keep their pins.</p>`, "", "Saved");
        $("#b-section-title", settings())?.focus();
      });
    });
  }

  // Removing (section 7): captured skill and revision; "Removed" only from a read that shows it.
  function remove() {
    const r = K.read;
    const sub = { id: K.page, base: r.rev, slug: r.slug };
    const mode = takeMode("remove");
    sent.push({ method: "skills.library.mutate", skillId: sub.id, expectedRevision: sub.base, action: "remove" });
    K.pending = "Removing…";
    K.status = null;
    rerender();
    announce("Removing");
    later(ANSWER, () => {
      const s = gw(sub.id);
      let answer;
      if (mode === "conflict") otherSave(sub.id);
      if (s.rev !== sub.base) answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_CONFLICT" };
      else if (mode === "refused") answer = { error: "INVALID_REQUEST", message: "Skill library authority changed. Refresh and retry." };
      else if (mode === "lostnot") answer = null;
      else {
        s.removed = true;
        answer = mode === "lost" ? null : { state: "removed" };
      }
      later(READ, () => {
        K.pending = null;
        const after = mode === "readfail" ? { error: "UNAVAILABLE" } : read(sub.id);
        const kept = dirty(); // unsaved text on the page, against the page's own read
        const unsavedLine = kept ? " Your unsaved text is still here." : "";
        const settle = (html, tone, said) => {
          K.status = statusNote(html, tone);
          announce(said);
          rerender();
        };
        if (after.removed === true) {
          const words = answer
            ? `Removed. Reading your library again: ${esc(sub.slug)} isn't in it. Tasks that have it keep their revision.`
            : "Reading the skill again shows it was removed. The gateway did not answer your request. Tasks that hold it keep their pins.";
          if (kept) {
            // The draft stays on the removed skill's page; only "Save text as a new skill" can take it.
            K.gone = true;
            settle(`<p>${words}${unsavedLine}</p><div class="b-actions">${button("Save text as a new skill", 'data-k="save-as-new" data-size="sm"')}</div>`, "warn", "Removed");
            return paintTask();
          }
          K.page = null;
          K.draft = null;
          K.listStatus = statusNote(`<p>${words}</p>`, answer ? "" : "warn");
          rerender();
          $("#b-section-title", settings())?.focus();
          announce("Removed");
          return paintTask();
        }
        if (after.error) {
          const words = answer?.error
            ? `The gateway answered: ${esc(answer.message || answer.code)} Couldn't read the skill again. The page shows the last readable revision.`
            : answer
              ? "The gateway answered that it removed the skill. Reading the skill again failed. The page still shows the previous read."
              : "Couldn't tell whether it was removed, and reading the skill again failed too. The page still shows the previous read.";
          return settle(`<p>${words}${unsavedLine}</p><div class="b-actions">${button("Read again", 'data-k="reread" data-size="sm"')}</div>`, "warn", "Couldn't read the skill again.");
        }
        if (kept && after.rev !== sub.base) K.compare = { theirs: after, readAt: clock() };
        else if (!kept) {
          K.read = after;
          K.draft = { slug: after.slug, description: after.description, body: after.body };
        }
        if (answer?.code === "SKILL_LIBRARY_CONFLICT") return settle(`<p>The gateway refused this removal because it read a different revision. Reading it again found revision ${rev(after.rev)}.${unsavedLine}</p>`, "warn", "Not removed");
        if (answer?.error) return settle(`<p>The gateway answered: ${esc(answer.message)} Reading it again found revision ${rev(after.rev)}.${unsavedLine}</p>`, "danger", "Not removed");
        settle(`<p>Couldn't tell whether it was removed. Reading it again: it is still in your library.${unsavedLine}</p>`, "warn", "Not removed");
      });
    });
  }

  // Sharing (section 8) and the defaults switch (section 4.1). Each request carries the saved
  // revision the page shows (expectedRevision); the gateway refuses it when the content has
  // changed since. The receipt and each read are reported apart: "Shared" only when the
  // gateway accepted it and both reads say so.
  const teamRead = (id, mode) => {
    // skills.library.list {scope: "team"}: is the skill among this gateway's shared skills?
    const s = gw(id);
    const listed = Boolean(s && !s.removed && s.shared);
    return mode === "split" ? !listed : listed;
  };
  // A refusal for a stale base: the flag is left alone, the draft keeps its old base.
  function refusedFlag(after, what) {
    const kept = dirty();
    if (kept) K.compare = { theirs: after, readAt: clock() };
    else {
      K.read = after;
      K.draft = { slug: after.slug, description: after.description, body: after.body };
    }
    return `<p>The gateway refused this request because it read a different revision. Reading it again found revision ${rev(after.rev)}, ${what(after)}.${kept ? " Your unsaved text stays here." : ""}</p>`;
  }
  function flagWrite({ kind, value, words, done, pending }) {
    const r = K.read;
    const sub = { id: K.page, base: r.rev, action: kind, value };
    sent.push({ method: "skills.library.mutate", skillId: sub.id, expectedRevision: sub.base, action: kind });
    const mode = takeMode(kind === "share" || kind === "unshare" ? "share" : "enable");
    K.pending = pending;
    K.status = null;
    rerender();
    announce(pending.replace("…", ""));
    later(ANSWER, () => {
      const s = gw(sub.id);
      let answer;
      if (s.rev !== sub.base) answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_CONFLICT", currentRevision: s.rev };
      else {
        s[sub.action === "share" || sub.action === "unshare" ? "shared" : "enabled"] = value;
        // raced: another device's opposite write on the same revision lands just after; both are accepted.
        if (mode === "raced") s[sub.action === "share" || sub.action === "unshare" ? "shared" : "enabled"] = !value;
        answer = mode === "lost" ? null : { state: "published" };
      }
      later(READ, () => {
        K.pending = null;
        const after = mode === "readfail" ? { error: "UNAVAILABLE" } : read(sub.id);
        const settle = (html, tone, said) => {
          K.status = html ? statusNote(html, tone) : null;
          announce(said);
          rerender();
          $(`[data-k="${kind === "share" || kind === "unshare" ? "share" : "enable"}"]`, settings())?.focus();
        };
        if (answer?.code === "SKILL_LIBRARY_CONFLICT" && after.rev) return settle(refusedFlag(after, words.state), "warn", "Not changed");
        if (after.removed) return settle(`<p>Reading the skill again shows it was removed.</p>`, "danger", "Removed");
        if (after.error) return settle(`<p>${answer ? "" : "The gateway did not answer this request. "}${words.readfail}</p><div class="b-actions">${button("Read again", 'data-k="reread" data-size="sm"')}</div>`, "warn", words.readfail);
        const facts = words.facts(after, sub.id, mode);
        K.read = { ...K.read, shared: after.shared, enabled: after.enabled, saved: after.saved };
        if (facts.split) return settle(`<p>${answer ? "" : "The gateway did not answer this request. "}The two reads reported different sharing states. Read again.</p><div class="b-actions">${button("Read again", 'data-k="reread" data-size="sm"')}</div>`, "warn", "The two reads differ");
        if (!answer) return settle(`<p>The gateway did not answer this request. ${facts.html}</p>`, "warn", "Couldn't tell whether it changed");
        if (facts.value !== value) return settle(`<p>The gateway accepted the request. The skill is ${words.state(after)} as of the next read.</p>`, "warn", words.said(after));
        settle(done(after, facts), "", words.said(after));
      });
    });
  }
  const SHARE_WORDS = {
    state: (a) => (a.shared ? "shared" : "not shared"),
    said: (a) => (a.shared ? "Shared on this gateway" : "Not shared"),
    readfail: "Couldn't read sharing again. The sharing status shown is from the earlier read.",
    facts: (a, id, mode) => {
      const listed = teamRead(id, mode);
      return {
        value: a.shared,
        split: listed !== a.shared,
        html: `Reading the skill again, it is ${a.shared ? `shared at revision ${rev(a.rev)}` : "not shared"}. The gateway's list of shared skills ${listed ? "includes" : "doesn't include"} it.`,
      };
    },
  };
  function share() {
    const shared = K.read.shared;
    flagWrite({
      kind: shared ? "unshare" : "share",
      value: !shared,
      words: SHARE_WORDS,
      pending: shared ? "Stopping sharing…" : "Sharing…",
      done: (a, f) => `<p>${a.shared ? "Shared." : "Not shared."} ${f.html}${a.shared ? "" : " Tasks that already have it keep their revision."}</p>`,
    });
  }
  function toggleDefaults() {
    const on = !K.read.enabled;
    flagWrite({
      kind: on ? "enable" : "disable",
      value: on,
      pending: "Saving…",
      words: {
        state: (a) => (a.enabled ? "included in defaults" : "not included in defaults"),
        said: (a) => (a.enabled ? "Included in defaults for new tasks" : "Not included in defaults"),
        readfail: "Couldn't read the skill again. The setting shown is from the earlier read.",
        facts: (a) => ({ value: a.enabled, split: false, html: `Reading the skill again, it is ${a.enabled ? "included in defaults" : "not included in defaults"}.` }),
      },
      done: () => "",
    });
  }

  // Skills in this task (section 9) --------------------------------------------------------------

  const taskKey = () => app.model.selectedTask;
  // A bot's effective filter: its own key, else the gateway's default; undefined is no filter.
  const filterOf = (bot) => (G.lists[bot] !== undefined ? { list: G.lists[bot], own: true } : { list: G.defaults, own: false });
  const filterWords = (bot) => {
    const f = filterOf(bot);
    const what = f.list === undefined ? "no filter" : f.list.length === 0 ? "none" : `only ${f.list.length}`;
    return f.own ? `its own filter, ${what}` : `the gateway's default, ${what}`;
  };
  const CAP = 64;
  // skills.library.list {sessionKey}: the task's selections, each with its own revision and text.
  const readTask = (key) => (pins[key] || []).map((x) => ({ ...x }));
  // What the section shows is the task's last read, kept per task with its time.
  const shown = (key) => (K.tasks[key] ||= { list: readTask(key), at: "5:41 PM", status: null, pending: null, held: null, attachOpen: false });
  // session.attachable: library entries this connection can read that the task doesn't hold, each at its current revision.
  const attachableFor = (list) => G.skills.filter((s) => visible(s) && !list.some((x) => x.skillId === s.id)).map((s) => ({ skillId: s.id, slug: s.slug, description: s.description, rev: s.rev }));

  // How a pin stands against the library, from this read.
  function pinState(x) {
    const s = gw(x.skillId);
    if (!s || !visible(s)) {
      const r = PINS === "entryfail" ? { error: "UNAVAILABLE" } : read(x.skillId);
      if (r.removed === true) return { kind: "removed", words: "Removed from the library" };
      if (r.code === "SKILL_LIBRARY_NOT_FOUND") return { kind: "unavailable", words: "Library entry unavailable" };
      return { kind: "unread", words: "Couldn't read the library entry" };
    }
    if (s.rev !== x.rev) return { kind: "different", words: "Different library revision", lib: s.rev };
    return { kind: "same" };
  }

  function taskSection() {
    const bot = app.model.selectedBot;
    const t = taskKey();
    if (!t) return "";
    const v = shown(t);
    if (v.held) return heldView(v.held);
    const list = v.list;
    let html = `<section class="work-section k-task" aria-labelledby="k-task-title" data-k-task="${esc(t)}"><h3 id="k-task-title" tabindex="-1">Skills in this task</h3>`;
    if (K.pinState === "error" && t === "j1")
      return html + `<p class="work-note">Couldn't load this task's skills. The gateway answered: Session not found.</p>${button("Try again", 'data-k="pins-retry" data-size="sm"')}</section>`;
    const states = list.map((x) => [x, pinState(x)]);
    const blocked = states.some(([, s]) => s.kind === "removed" || s.kind === "unavailable");
    const different = states.some(([, s]) => s.kind === "different");
    const busyHere = Boolean(v.pending) || !online();
    html += `<p class="b-hint k-pins-read">As read at ${v.at}. The skills this task has saved for its next turns, each at its revision.</p>`;
    if (v.pending) html += pendingLine(v.pending);
    if (different && canWrite())
      html += `<div class="k-update">${button("Update to the library's current revisions", `data-k="refresh" data-size="sm"${blocked || busyHere ? " disabled" : ""}`)}<small>${blocked ? "Detach the skills marked unavailable or removed first: the gateway refuses to update a task that has one." : "Updates every skill in this task."}</small></div>`;
    if (!list.length) html += `<p class="work-note">This task has no skills from your library.</p>`;
    else
      html += `<ul class="k-pins">${states
        .map(([x, st]) => {
          const status = STATUS[x.skillId];
          const ineligible = status && status.eligible === false;
          const tags = [st.kind !== "same" ? tag(st.words, st.kind === "different" ? "" : "warn") : "", ineligible ? tag("Not eligible in the gateway's skill status") : "", status?.missing ? tag("Needs not met") : ""].join("");
          const line = [
            st.kind === "different" ? `The library has revision ${st.lib.slice(0, 12)}.` : "",
            ineligible ? `The gateway's skill status for this task lists it as not eligible${status.disabled ? ", and as disabled" : ""}.` : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            `<li class="k-pin"><button type="button" class="k-pin-open" data-k-pin="${x.skillId}" aria-label="${esc(`${x.slug}, revision ${x.rev.slice(0, 12)}${st.kind !== "same" ? `, ${st.words.toLowerCase()}` : ""}${ineligible ? ", not eligible in the gateway's skill status" : ""}`)}">` +
            `<span class="k-row-name">${esc(x.slug)}</span>${rev(x.rev)}<span class="k-tags">${tags}</span></button>` +
            (canWrite() ? button("Detach", `data-k="detach" data-value="${x.skillId}" data-size="sm" aria-label="Detach ${esc(x.slug)}"${busyHere ? " disabled" : ""}`, "quiet") : "") +
            (line ? `<small class="k-why">${esc(line)}</small>` : "") +
            `</li>`
          );
        })
        .join("")}</ul>`;
    html += `<p class="b-hint k-filter-line">${esc(botName(bot))}'s skill filter is ${esc(filterWords(bot))}. A filter can leave out a skill this task has; it is set in ${esc(botName(bot))}'s settings, apart from these.</p>`;
    if (canWrite()) {
      const attachable = attachableFor(list);
      const full = list.length >= CAP;
      html += `<div class="k-attach"><button type="button" class="button" data-size="sm" data-k="attach-open" aria-expanded="${v.attachOpen}"${busyHere || full ? " disabled" : ""}>Attach a skill</button>`;
      if (full) html += `<p class="work-note">This task already has 64 library skills. Detach one to make room.</p>`;
      else if (v.attachOpen)
        html += attachable.length
          ? `<ul class="k-attach-list" aria-label="Skills to attach">${attachable.map((s) => `<li><button type="button" class="k-attach-item" data-k="attach" data-value="${s.skillId}" data-rev="${s.rev}"><span class="k-row-name">${esc(s.slug)}</span>${rev(s.rev)}<small>${esc(s.description)}</small></button></li>`).join("")}</ul>`
          : `<p class="work-note">No skills are available to attach.</p>`;
      html += `</div>`;
    } else html += `<p class="b-hint">Changing a task's skills needs write access.</p>`;
    if (v.status) html += v.status;
    return html + `</section>`;
  }

  function heldView(id) {
    const x = shown(taskKey()).list.find((y) => y.skillId === id);
    return (
      `<section class="work-section k-task k-held" aria-labelledby="k-held-title"><div class="b-subhead">${backTo("Back to details", "held-back")}<h3 id="k-held-title" tabindex="-1">${esc(x.slug)}</h3></div>` +
      CONTENT +
      `<p class="b-hint">Revision ${rev(x.rev)}, the one this task has.</p>` +
      `<p class="k-label">Use when…</p><p class="k-ro">${esc(x.description)}</p><p class="k-label">Instructions</p><pre class="k-plain" data-k-held>${esc(x.body)}</pre></section>`
    );
  }

  let paintedTask = null;
  function paintTask(focus) {
    const host = $("#panel-details");
    if (!host) return;
    // Choosing another task closes a held revision that was open; nothing of one task shows in another.
    if (paintedTask && paintedTask !== taskKey() && K.tasks[paintedTask]) {
      K.tasks[paintedTask].held = null;
      K.tasks[paintedTask].attachOpen = false;
    }
    paintedTask = taskKey();
    $(".k-task", host)?.remove();
    host.insertAdjacentHTML("beforeend", taskSection());
    if (focus) $(focus, host)?.focus();
  }
  CT.skillsTaskSection = () => paintTask();

  // A task write, captured with its task, skill and revision at the click; the section of
  // that task alone says what the next read of that task shows (section 9).
  function taskWrite(kind, skillId, revision) {
    const key = taskKey();
    const sub = { key, kind, skillId, revision };
    const request = { method: "skills.library.activate", sessionKey: key, action: kind, ...(skillId ? { skillId } : {}), ...(kind === "attach" ? { revision } : {}) };
    sent.push(request);
    const mode = takeMode("task");
    const v = shown(key);
    v.pending = { refresh: "Updating…", detach: "Detaching…", attach: "Attaching…" }[kind];
    v.status = null;
    v.attachOpen = false;
    paintTask();
    later(ANSWER, () => {
      const list = pins[sub.key] || (pins[sub.key] = []);
      let answer;
      if (mode === "refused") answer = { error: "Session changed before activation; refresh and retry." };
      else if (kind === "refresh") {
        if (list.some((x) => !gw(x.skillId) || !visible(gw(x.skillId)))) answer = { error: "A selected skill is no longer available. Detach it before refreshing." };
        else {
          list.forEach((x, i) => (list[i] = pinOf(x.skillId)));
          answer = { ok: true };
        }
      } else if (kind === "detach") {
        pins[sub.key] = list.filter((y) => y.skillId !== sub.skillId);
        answer = { ok: true };
      } else {
        const pin = pinOf(sub.skillId, sub.revision);
        if (list.length >= CAP) answer = { error: "This session already has 64 library skills." };
        else if (!pin) answer = { error: "Skill revision not found." };
        else {
          list.push(pin);
          answer = { ok: true, selection: { skillId: pin.skillId, revision: pin.rev } };
        }
      }
      if (mode === "lost" && answer.ok) answer = null;
      later(READ, () => {
        v.pending = null;
        const running = p("running") === "1" ? " The turn running now keeps the skills it started with." : "";
        const after = mode === "readfail" ? null : readTask(sub.key);
        const unsure = answer ? "" : "Couldn't tell whether the change reached the gateway. ";
        let words;
        if (!after) words = `${answer?.error ? `The gateway answered: ${esc(answer.error)} ` : unsure}Couldn't read this task's skills again.`;
        else {
          v.list = after;
          v.at = clock();
          const held = after.find((x) => x.skillId === sub.skillId);
          if (answer?.error) words = `The gateway answered: ${esc(answer.error)} The skills shown are from the next read.`;
          else if (kind === "refresh") words = `${answer ? "Updated. " : unsure}Reading the task again shows these saved revisions, from its next turn.${running}`;
          else if (kind === "detach") words = held ? `${unsure}Reading the task again, it still has revision ${held.rev.slice(0, 12)}.` : `${answer ? "Detached. " : unsure}Reading the task again, it no longer has that skill.${running}`;
          else if (!held) words = `${unsure}Reading the task again, it doesn't have that skill.`;
          else if (answer && held.rev !== answer.selection.revision) words = `The gateway returned revision ${held.rev.slice(0, 12)}. Reading the task again, it has revision ${held.rev.slice(0, 12)}.`;
          else words = `${answer ? "Attached. " : unsure}Reading the task again, it has revision ${held.rev.slice(0, 12)}. From this task's next turn.${running}`;
        }
        v.status = `<p class="${answer?.error || !after ? "b-field-error" : "b-hint"}" role="status">${words}</p>`;
        // Only the task the write was for shows or announces it.
        if (sub.key !== taskKey()) return;
        paintTask();
        announce(!after ? "Couldn't read this task's skills again." : answer?.error ? "Couldn't change the task's skills" : answer ? { refresh: "Updated", detach: "Detached", attach: "Attached" }[kind] : "Couldn't tell whether it changed");
      });
    });
  }

  // A bot's skills (section 10) ------------------------------------------------------------------

  const rowWord = (bot) => {
    const l = G.lists[bot];
    if (l === undefined) return "Gateway default";
    return l.length === 0 ? "None" : `Only ${l.length}`;
  };
  CT.botsToolsRows = (id) =>
    `<div><dt>Permissions</dt><dd>Ask before running commands</dd></div>` +
    `<div><button type="button" class="b-open" data-bs="skills"><span>Skill filter</span><span class="b-open-value">${rowWord(id)}</span>${icon("chevron")}</button></div>`;
  const sub = (title, to, label) =>
    `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="${to}" aria-label="${label}">${icon("back")}</button><h3 tabindex="-1" data-bs-focus>${title}</h3></div>`;

  function defaultWords() {
    if (G.defaults === undefined) return "The gateway sets no default skill filter.";
    if (G.defaults.length === 0) return "The gateway's default skill filter is an empty list.";
    return `The gateway's default is only ${G.defaults.map((n) => n).join(", ")}.`;
  }

  function skillsView(bot) {
    const name = esc(botName(bot));
    const saved = G.lists[bot];
    const savedChoice = saved === undefined ? "default" : saved.length ? "only" : "none";
    const d = K.listDraft && K.listDraft.bot === bot ? K.listDraft : { bot, choice: savedChoice, names: [...(saved || [])] };
    K.listDraft = d;
    // Filter edits wait while a save is pending.
    const editable = isAdmin() && online() && !K.listPending;
    const dis = editable ? "" : ' aria-disabled="true"';
    const radio = (value, label, line) =>
      `<li><button type="button" class="b-choice" role="radio" aria-checked="${d.choice === value}" data-k-choice="${value}"${dis}><span class="b-choice-text"><span class="b-choice-title">${label}</span><span class="b-choice-sub b-wrap">${line}</span></span>${icon("check", "icon b-tick")}</button></li>`;
    let html = sub(`${name}'s skills`, "main", "Back to settings");
    html += `<p class="b-hint" style="margin-top:0">A filter narrows the skills ${name} can be given in a task. It doesn't add any: a task is given a library skill only if it has it (see a task's Details), and any skill only if the gateway says what it needs is there.</p>`;
    html += `<h4 class="b-group">${name}'s skill filter</h4>`;
    html +=
      `<ul class="b-choices" role="radiogroup" aria-label="${name}'s skill filter">` +
      radio("default", "Use the gateway's default", esc(defaultWords())) +
      radio("only", "Only these", "The skills checked below, by the names the gateway gives them.") +
      radio("none", "None", `${name}'s configured filter is an empty list.`) +
      `</ul>`;
    if (d.choice === "only") {
      const lib = G.skills.filter((s) => visible(s));
      const box = (value, label) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-k-name="${esc(value)}"${d.names.includes(value) ? " checked" : ""}${editable ? "" : " disabled"} /> ${label}</label></div>`;
      html += `<p class="k-subgroup">Your library</p><dl class="facts">${lib.map((s) => box(s.name, `<span class="k-box-text"><span>${esc(s.slug)}</span><small class="k-cmd mono">${esc(s.name)}</small></span>`)).join("")}</dl>`;
      html += `<p class="k-subgroup">On the gateway</p><dl class="facts">${GATEWAY_SKILLS.map((n) => box(n, `<span class="mono">${esc(n)}</span>`)).join("")}</dl>`;
      const unknown = d.names.filter((n) => !lib.some((s) => s.name === n) && !GATEWAY_SKILLS.includes(n));
      if (unknown.length)
        html +=
          `<p class="k-subgroup">Not in the gateway's lists now</p><dl class="facts">${unknown.map((n) => `<div class="b-row"><span class="b-row-main"><span class="mono k-cmd-wrap">${esc(n)}</span></span>${editable ? button("Remove from the filter", `data-k="list-drop" data-value="${esc(n)}" data-size="sm"`, "quiet") : ""}</div>`).join("")}</dl>` +
          `<p class="b-hint">No matching skill is listed in these reads. A task may still hold a pin with this command name.</p>`;
    }
    html += `<p class="b-hint" id="k-filter-limits">The gateway also applies a task's own skill overrides, which this page doesn't read. Learned skills bypass this filter. Gateway eligibility and skill settings still apply. This filter does not restrict which files the bot's commands can read.</p>`;
    if (K.listPending) html += pendingLine("Saving…");
    if (K.listNote) html += K.listNote;
    if (isAdmin()) {
      const changed = d.choice !== savedChoice || (d.choice === "only" && JSON.stringify([...d.names].sort()) !== JSON.stringify([...(saved || [])].sort()));
      html += `<div class="b-actions" style="margin-top:12px">${button("Save", `data-k="list-save" data-size="sm"${changed && !K.listPending && online() && !(d.choice === "only" && !d.names.length) ? "" : " disabled"}`, "primary")}</div>`;
      if (d.choice === "only" && !d.names.length) html += `<p class="b-field-error">Check at least one skill, or choose None.</p>`;
    }
    html += learnedHtml(bot);
    return html;
  }

  const changeLine = (bot, name) => {
    const c = (G.changes[bot] || []).find((x) => x.skill === name);
    if (!c) return "When it was saved isn't in the gateway's recent changes.";
    const who = c.actor === "agent" ? botName(bot) : c.actor === "review" ? "the gateway's review" : "a person";
    const what = { create: "Saved", patch: "Changed", archive: "Archived", restore: "Restored" }[c.action] || "Changed";
    return `${what} by ${who}${c.task ? ` in ${c.task}` : ""}, ${c.at}`;
  };

  // A snapshot, labelled by the action the workshop kept it for (its id ends with that action).
  const snapshotLine = (v) => {
    const action = v.id.slice(v.id.indexOf("-") + 1);
    return action === "archive" ? `Archived ${v.at}` : `${{ patch: "Kept before a patch", write_file: "Kept before a file was written", restore: "Kept before a restore" }[action] || "Kept"}, ${v.at}`;
  };
  const noteFor = (bot) => (K.learnedNote?.bot === bot ? K.learnedNote.html : "");
  const workshopIdle = () => !K.learnedPending && online();

  function learnedHtml(bot) {
    const name = esc(botName(bot));
    const all = G.learned[bot] || [];
    const live = all.filter((l) => l.live);
    const archived = all.filter((l) => l.versions.length);
    let html = `<h4 class="b-group">What ${name} learned</h4><p class="b-hint" style="margin-top:0">Skills saved for ${name} on the gateway, by ${name} or by the gateway's review. They bypass the filter above; the gateway still gives one only when what it needs is there.</p>`;
    html += live.length
      ? `<ul class="k-rows">${live.map((l) => `<li><button type="button" class="k-row" data-k-learned="${esc(l.name)}" data-bs="learned"><span class="k-row-main"><span class="k-row-name mono">${esc(l.name)}</span><span class="k-row-when">${esc(l.description)}</span><small class="k-from">${esc(changeLine(bot, l.name))}</small></span>${icon("chevron")}</button></li>`).join("")}</ul>`
      : archived.length
        ? `<p class="work-note">No live learned skills.</p>`
        : `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>Nothing learned yet</h4><p>When a skill is saved for ${name}, it shows here.</p></div>`;
    if (archived.length)
      html += `<p class="k-subgroup">Saved versions</p><dl class="facts">${archived
        .map(
          (l) =>
            `<div class="b-row" data-k-archived="${esc(l.name)}"><span class="b-row-main"><span class="mono">${esc(l.name)}</span><small>${esc([l.live ? "Live" : "Archived", ...l.versions.map(snapshotLine)].join(" · "))}</small></span>${
              isAdmin() && !l.live ? button("Restore latest saved version", `data-k="restore" data-value="${esc(l.name)}" data-size="sm"${workshopIdle() ? "" : " disabled"}`) : ""
            }</div>`,
        )
        .join("")}</dl>`;
    if (K.learnedPending?.bot === bot) html += pendingLine(K.learnedPending.word);
    html += noteFor(bot);
    html += `<dl class="facts" style="margin-top:12px">${fact("Learning on its own", G.mode === "auto" ? "On" : "Off")}</dl><p class="b-hint">The gateway's documentation says background review can save or update skills and archive idle ones. This page shows up to 50 recent changes.</p>`;
    return html;
  }

  function learnedView(bot) {
    const l = (G.learned[bot] || []).find((x) => x.name === K.learnedOpen) || (G.learned[bot] || [])[0];
    if (!l) return skillsView(bot);
    const changes = (G.changes[bot] || []).filter((c) => c.skill === l.name);
    let html = sub(`<span class="k-title">${esc(l.name)}</span>`, "skills", `Back to ${esc(botName(bot))}'s skills`);
    html += CONTENT;
    html += `<p class="k-label">Its text, as the gateway keeps it</p><pre class="k-plain">${esc(l.text)}</pre>`;
    html += `<dl class="facts">${fact("Files", l.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(", "))}</dl>`;
    html += `<h4 class="b-group">Changes</h4><ul class="k-changes">${changes.map((c) => `<li>${esc(`${{ create: "Saved", archive: "Archived", restore: "Restored" }[c.action] || "Changed"} by ${c.actor === "agent" ? botName(bot) : c.actor === "review" ? "the gateway's review" : "a person"}${c.task ? ` in ${c.task}` : ""}, ${c.at}`)}</li>`).join("")}</ul>`;
    html += `<p class="b-hint">Clawtrate can read learned instructions here. Editing them is unavailable.</p>`;
    if (K.learnedPending?.bot === bot) html += pendingLine(K.learnedPending.word);
    html += noteFor(bot);
    if (isAdmin() && l.live) html += `<div class="b-actions" style="margin-top:12px">${button("Archive…", `data-k="archive" data-size="sm" data-tone="danger"${workshopIdle() ? "" : " disabled"}`, "quiet")}</div>`;
    return html;
  }

  // An archive or restore, captured with its bot, skill and action; the result is said from the
  // next skills.workshop.list, and only in that bot's view (section 10.2).
  function workshopWrite(sub) {
    sent.push({ method: `skills.workshop.${sub.kind}`, agentId: sub.bot, name: sub.name });
    const mode = takeMode("learned");
    K.learnedPending = { bot: sub.bot, word: sub.kind === "archive" ? "Archiving…" : "Restoring…" };
    K.learnedNote = null;
    rerenderTab();
    later(ANSWER, () => {
      const l = (G.learned[sub.bot] || []).find((x) => x.name === sub.name);
      let answer = { ok: true };
      if (mode === "refused") answer = { error: sub.kind === "archive" ? `Skill "${sub.name}" is not live.` : `Skill "${sub.name}" has no saved versions to restore.` };
      else if (sub.kind === "archive") {
        l.live = false;
        l.versions.unshift({ id: "20261119T150206000Z-archive", at: clock() });
        G.changes[sub.bot].unshift({ skill: l.name, action: "archive", actor: "user", at: l.versions[0].at });
      } else {
        l.live = true;
        G.changes[sub.bot].unshift({ skill: l.name, action: "restore", actor: "user", at: clock() });
      }
      if (mode === "lost") answer = null;
      later(READ, () => {
        K.learnedPending = null;
        const read = mode === "readfail" ? null : (G.learned[sub.bot] || []).find((x) => x.name === sub.name);
        const found = read && (read.live ? `Reading again, ${esc(sub.name)} is live for ${esc(botName(sub.bot))}.` : `Reading again, ${esc(sub.name)} is archived.`);
        const wanted = read && (sub.kind === "archive" ? !read.live : read.live);
        let html;
        if (!read) html = `<p class="b-field-error" role="status">${answer?.error ? `The gateway answered: ${esc(answer.error)} ` : answer ? "" : "Couldn't tell whether the change reached the gateway. "}Couldn't read ${esc(botName(sub.bot))}'s learned skills again.</p>`;
        else if (answer?.error) html = `<div role="status"><p class="b-field-error">The gateway answered: ${esc(answer.error)}</p><p class="b-hint">${found}</p></div>`;
        else html = `<p class="b-hint" role="status">${answer ? "" : "Couldn't tell whether the change reached the gateway. "}${found}</p>`;
        K.learnedNote = { bot: sub.bot, html };
        if (sub.kind === "archive" && wanted && BS.S.view === "learned") BS.S.view = "skills";
        rerenderTab();
        announce(!read ? "Couldn't read the learned skills again." : answer?.error ? (sub.kind === "archive" ? "Not archived" : "Not restored") : !answer ? "Couldn't tell whether it changed" : wanted ? (sub.kind === "archive" ? "Archived" : "Restored") : "Not changed");
      });
    });
  }

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { skills: skillsView, learned: learnedView });
  CT.botsPageNeeds = Object.assign(CT.botsPageNeeds || {}, {
    skills: (n) => `Changing ${n}'s skill filter changes the gateway's settings. Archiving what ${n} learned needs admin access too.`,
    learned: (n) => `Archiving a skill ${n} learned needs admin access.`,
  });

  const rerenderTab = () => BS.render();

  // The configured value, in words, as config.get returns it.
  const cfgWords = (list) => (list === undefined ? "not set, so the gateway's default applies" : list.length === 0 ? "an empty list" : `only ${list.join(", ")}`);
  function saveList(bot) {
    const d = K.listDraft;
    const subm = { bot, value: d.choice === "default" ? undefined : d.choice === "none" ? [] : [...d.names], draft: { ...d, names: [...d.names] } };
    const mode = takeMode("cfg");
    sent.push({ method: "config.patch", path: `agents.entries.${bot}.skills`, value: subm.value === undefined ? null : subm.value, replacePaths: [`agents.entries.${bot}.skills`] });
    K.listPending = true;
    K.listNote = null;
    rerenderTab();
    later(ANSWER, () => {
      let answer = { ok: true };
      if (mode === "conflict") {
        G.lists[bot] = []; // another admin's write landed first
        answer = { error: "config changed since last load; re-run config.get and retry" };
      } else if (mode === "refused") answer = { error: "invalid config: agents.entries.main.skills must be an array of strings" };
      else {
        if (subm.value === undefined) delete G.lists[bot];
        else G.lists[bot] = subm.value;
        // differs: another admin's write lands just after this one.
        if (mode === "differs") G.lists[bot] = ["github"];
        if (mode === "lost") answer = null;
      }
      later(READ, () => {
        K.listPending = false;
        const read = mode === "readfail" ? null : { value: G.lists[bot] };
        const same = read && JSON.stringify(read.value) === JSON.stringify(subm.value);
        const now = read ? esc(cfgWords(read.value)) : "";
        // The page shows what config.get returns, except that the submitted choice stays
        // selected when the read failed or doesn't establish it.
        K.listDraft = !read || (!answer?.error && !same) ? subm.draft : null;
        let html;
        if (!read) html = `<div role="status">${note(`<p>${answer?.error ? `The gateway refused this request. Its answer: ${esc(answer.error)} ` : answer ? "The gateway answered the request. " : "Couldn't tell whether it was saved. "}Couldn't read the settings again. The filter shown is from the earlier read; your choice is still selected.</p>`, "warn")}</div>`;
        else if (answer?.error) html = `<div role="status">${note(`<p>The gateway refused this request. Its answer: ${esc(answer.error)} Reading again, the configured filter is ${now}.</p>`, "danger")}</div>`;
        else if (!answer) html = `<div role="status">${note(`<p>Couldn't tell whether it was saved. Reading again, the configured filter is ${now}.</p>`, "warn")}</div>`;
        else if (!same) html = `<div role="status">${note(`<p>The gateway answered the request. Reading again found ${now}.</p>`, "warn")}</div>`;
        else html = `<p class="b-hint" role="status">Saved. Reading again, the configured filter is ${now}. It applies from each task's next turn; a turn running now keeps the skills it started with.</p>`;
        K.listNote = html;
        announce(!read ? "Couldn't read the settings again." : answer?.error ? "Not saved" : !answer ? "Couldn't tell whether it was saved" : same ? "Saved" : "The read found another value");
        rerenderTab();
        paintTask();
      });
    });
  }

  // The cards (section 12): the line under a library save, from a read of this task.
  // The card's recorded skillId, for the fixture's library entry it names (the fixture keys
  // its entries by short names; the gateway keys them by this id).
  const CARD_ID = JSON.parse(CT.skillsCalls.find((c) => c.id === "k-card-saved").result).entry.skillId;
  const cardEntry = (skillId) => (skillId && skillId === CARD_ID ? "trail" : null);
  function paintCards() {
    // Each card's state, now that the library's profileId says who is viewing.
    for (const c of CT.skillsCalls || []) {
      const el = document.getElementById(c.id);
      if (!el) continue;
      const k = CT.skillsCardOf(c, G.profile);
      el.querySelector(".action-state .state").textContent = k.state;
      el.querySelector(":scope > summary").setAttribute("aria-label", `${k.verb} ${k.object}, ${k.state}`);
    }
    const line = $("#k-card-attach");
    const key = taskKey();
    if (!line || !key || line.querySelector(".k-pending")) return;
    const id = cardEntry(line.dataset.kSkillId);
    const cardRev = line.dataset.kRev;
    if (K.mode.cardread === "fail") return (line.innerHTML = `<span>Couldn't read this task's skills.</span>`);
    const list = shown(key).list;
    const s = id && gw(id);
    const held = list.find((x) => x.skillId === id);
    const offered = attachableFor(list).find((x) => x.skillId === id);
    const why = "This task doesn't have it: a skill saved during a task isn't added to that task.";
    if (held) line.innerHTML = `<span>This task has it, revision ${esc(held.rev.slice(0, 12))}.</span>`;
    else if (!s || !visible(s) || !offered) line.innerHTML = `<span>It isn't in your library now, so it can't be attached here.</span>`;
    else if (!canWrite()) line.innerHTML = `<span>This task doesn't have it. Attaching it needs write access.</span>`;
    else if (list.length >= CAP) line.innerHTML = `<span>This task already has 64 library skills. Detach one to make room.</span>`;
    else if (offered.rev !== cardRev)
      line.innerHTML = `<span>${why} The library now offers revision ${esc(offered.rev.slice(0, 12))}.</span><button type="button" class="button" data-size="sm" data-k="card-attach" data-rev="${offered.rev}"${online() ? "" : " disabled"}>Attach current revision</button>`;
    else line.innerHTML = `<span>${why}</span><button type="button" class="button" data-size="sm" data-k="card-attach" data-rev="${cardRev}"${online() ? "" : " disabled"}>Use in this task</button>`;
  }
  CT.skillsCards = paintCards;

  // Wiring -------------------------------------------------------------------------------------------

  document.addEventListener("input", (event) => {
    const f = event.target.closest("[data-k-field]");
    if (f && K.draft && !f.readOnly) {
      K.draft[f.dataset.kField] = f.value;
      if (f.dataset.kField === "slug" && K.nameTaken && f.value !== K.nameTaken) K.nameTaken = null;
      refreshForm();
    }
  });
  document.addEventListener("change", (event) => {
    const box = event.target.closest("[data-k-name]");
    if (box && K.listDraft && !K.listPending) {
      const n = box.dataset.kName;
      K.listDraft.names = box.checked ? [...new Set([...K.listDraft.names, n])] : K.listDraft.names.filter((x) => x !== n);
      rerenderTab();
      $(`[data-k-name="${CSS.escape(n)}"]`, $("#panel-settings"))?.focus();
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s" && settings()?.open && $('[data-k="save"]:not([disabled])', settings())) {
      event.preventDefault();
      save();
    }
  });

  // Leaving a page with unsaved text asks first (section 5).
  const unsaved = () => B.settings.section === "skills" && K.page && dirty() && canWrite();
  // While a skill write is pending, Back, Close, Escape and changing section wait for its result.
  const pendingWrite = () => B.settings.section === "skills" && K.page && Boolean(K.pending);
  const waitForIt = () => announce(`${K.pending} Waiting for the gateway's answer.`);
  function leave(then) {
    if (pendingWrite()) return waitForIt();
    if (!unsaved()) return then();
    D.confirmBox({
      title: "Leave without saving?",
      text: `Your edit to ${esc(K.page === "new" ? "this new skill" : K.read?.slug)} is lost.`,
      action: "danger",
      label: "Leave",
      run: then,
    });
  }
  const closeSettings = () => {
    K.page = null;
    K.draft = null;
    settings().close();
  };
  // Escape on the dialog goes through the same question as Close.
  settings().addEventListener("cancel", (event) => {
    if (pendingWrite() && !document.querySelector("#confirm-dialog[open]")) {
      event.preventDefault();
      return waitForIt();
    }
    if (unsaved() && !document.querySelector("#confirm-dialog[open]")) {
      event.preventDefault();
      leave(closeSettings);
    }
  });

  document.addEventListener(
    "click",
    (event) => {
      const close = event.target.closest('#settings-dialog [data-b="close"]');
      if (close && (pendingWrite() || unsaved())) {
        event.stopPropagation();
        event.preventDefault();
        return leave(closeSettings);
      }
      // Moving to another Settings section with unsaved text asks too.
      const section = event.target.closest("#settings-dialog [data-b-section]");
      if (section && section.dataset.bSection !== "skills" && (pendingWrite() || unsaved())) {
        event.stopPropagation();
        event.preventDefault();
        return leave(() => {
          K.page = null;
          K.draft = null;
          section.click();
        });
      }
      const learned = event.target.closest("[data-k-learned]");
      if (learned) K.learnedOpen = learned.dataset.kLearned;
      const nav = event.target.closest("#panel-settings [data-bs]");
      if (nav && nav.dataset.bs !== BS.S.view) {
        K.listNote = null;
        K.learnedNote = null;
        if (nav.dataset.bs !== "learned") K.listDraft = null;
      }
    },
    true,
  );

  document.addEventListener("click", (event) => {
    const open = event.target.closest("[data-k-skill]");
    if (open) {
      openPage(open.dataset.kSkill);
      rerender();
      return $("#b-section-title", settings())?.focus();
    }
    const pin = event.target.closest("[data-k-pin]");
    if (pin) {
      shown(taskKey()).held = pin.dataset.kPin;
      return paintTask("#k-held-title");
    }
    const choice = event.target.closest("[data-k-choice]");
    if (choice && isAdmin() && online() && K.listDraft && !K.listPending) {
      K.listDraft.choice = choice.dataset.kChoice;
      rerenderTab();
      return $(`[data-k-choice="${choice.dataset.kChoice}"]`, $("#panel-settings"))?.focus();
    }
    const t = event.target.closest("[data-k]");
    if (!t || t.disabled) return;
    const value = t.dataset.value;
    const bot = app.model.selectedBot;
    switch (t.dataset.k) {
      case "new":
        openPage("new");
        rerender();
        return $("#k-slug", settings())?.focus();
      case "to-list":
        return leave(() => {
          const from = K.page;
          K.page = null;
          K.draft = null;
          K.status = null;
          rerender();
          ($(`[data-k-skill="${from}"]`, settings()) || $("#b-section-title", settings()))?.focus();
        });
      case "lib-retry":
        K.lib = "ready";
        return rerender();
      case "lib-read":
        K.readAt = clock();
        rerender();
        return announce(`Read at ${K.readAt}`);
      case "reread": {
        const r = read(K.page);
        if (r.rev) K.read = r;
        K.status = statusNote(`<p>Read again: revision ${rev(K.read.rev)}, updated ${esc(K.read.saved)}.${dirty() ? " Your text is still here, unsaved." : ""}</p>`);
        return rerender();
      }
      case "save":
        return save();
      case "save-mine":
        return save({ over: true });
      case "use-theirs":
        return D.confirmBox({
          title: "Discard your edit?",
          text: "Your text is deleted from this page. The gateway's version stays.",
          action: "danger",
          label: "Discard",
          run: () => {
            const r = K.compare.theirs;
            K.compare = null;
            K.read = r;
            K.draft = { slug: r.slug, description: r.description, body: r.body };
            K.status = statusNote(`<p>Showing the gateway's version, revision ${rev(r.rev)}.</p>`);
            rerender();
          },
        });
      case "save-as-new": {
        const d = K.draft;
        openPage("new");
        K.saveAsNew = true;
        K.draft = { slug: "", description: d.description, body: d.body };
        K.status = statusNote(`<p>The removed skill's other settings and files aren't copied: the new skill has only this Use when… and these instructions. Give it a name to save it.</p>`, "warn");
        rerender();
        return $("#k-slug", settings())?.focus();
      }
      case "enable":
        return toggleDefaults();
      case "share":
        return share();
      case "remove":
        return D.confirmBox({
          title: `Remove ${esc(K.read.slug)}?`,
          text:
            "It leaves your library and new tasks won't begin with it. Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name." +
            (dirty() ? " If the skill is removed, your unsaved text stays here. You can save it as a new skill." : ""),
          action: "danger",
          label: "Remove",
          run: remove,
        });
      // Skills in this task
      case "held-back": {
        const v = shown(taskKey());
        const from = v.held;
        v.held = null;
        paintTask();
        return $(`[data-k-pin="${from}"]`, $("#panel-details"))?.focus();
      }
      case "pins-retry":
        K.pinState = "ready";
        return paintTask();
      case "refresh":
        return taskWrite("refresh");
      case "detach": {
        const x = shown(taskKey()).list.find((y) => y.skillId === value);
        const st = pinState(x);
        if (st.kind === "removed" || st.kind === "unavailable")
          return D.confirmBox({
            title: `Detach ${esc(x.slug)}?`,
            text: st.kind === "removed" ? "It was removed from your library, so it can't be attached again." : "Its library entry isn't available to this connection, so it may not be attachable again.",
            action: "danger",
            label: "Detach",
            run: () => taskWrite("detach", value),
          });
        return taskWrite("detach", value);
      }
      case "attach-open": {
        const v = shown(taskKey());
        v.attachOpen = !v.attachOpen;
        paintTask();
        return $('[data-k="attach-open"]', $("#panel-details"))?.focus();
      }
      case "attach":
        // The revision the attachable row showed at the click.
        return taskWrite("attach", value, t.dataset.rev);
      // A bot's skills
      case "list-save":
        return saveList(bot);
      case "list-drop":
        K.listDraft.names = K.listDraft.names.filter((n) => n !== value);
        return rerenderTab();
      case "archive":
      case "restore": {
        // Checked again at dispatch: admin, connected, nothing pending.
        if (!isAdmin() || !workshopIdle()) return;
        const kind = t.dataset.k;
        const name = kind === "archive" ? ((G.learned[bot] || []).find((x) => x.name === K.learnedOpen) || G.learned[bot][0]).name : value;
        const run = () => workshopWrite({ bot, name, kind });
        if (kind === "restore") return run();
        return D.confirmBox({
          title: `Archive ${esc(name)}?`,
          text: "The gateway will move this learned skill into its archive. You can restore it later.",
          action: "danger",
          label: "Archive",
          run,
        });
      }
      // The cards
      case "card-open": {
        const id = cardEntry($("#k-card-attach")?.dataset.kSkillId);
        if (id) openPage(id);
        return D.openSettings(t, "skills");
      }
      case "card-learned":
        K.learnedOpen = "trail-checklist";
        return CT.botsOpenSettings ? CT.botsOpenSettings("juniper", "learned") : null;
      case "card-attach": {
        // Captured at the click: the actual task, the card's recorded skill and the revision the line offered.
        const line = $("#k-card-attach");
        const sub = { key: taskKey(), skillId: cardEntry(line.dataset.kSkillId), revision: t.dataset.rev };
        if (!sub.key || !sub.skillId || !canWrite() || !online()) return;
        sent.push({ method: "skills.library.activate", sessionKey: sub.key, action: "attach", skillId: sub.skillId, revision: sub.revision });
        const mode = takeMode("card");
        line.innerHTML = `<span class="k-pending"><span class="status-dot" data-status="connecting"></span>Attaching…</span>`;
        return later(ANSWER, () => {
          const list = pins[sub.key] || (pins[sub.key] = []);
          const pin = pinOf(sub.skillId, sub.revision);
          let answer;
          if (mode === "refused") answer = { error: "Session changed before activation; refresh and retry." };
          else if (list.length >= CAP) answer = { error: "This session already has 64 library skills." };
          else if (!pin) answer = { error: "Skill revision not found." };
          else list.push(pin), (answer = { ok: true, selection: { skillId: pin.skillId, revision: pin.rev } });
          later(READ, () => {
            const v = shown(sub.key);
            const after = mode === "readfail" ? null : readTask(sub.key);
            if (after) (v.list = after), (v.at = clock());
            const held = after?.find((x) => x.skillId === sub.skillId);
            const told = answer.error ? `The gateway answered: ${esc(answer.error)} ` : "";
            const words = !after
              ? `${told}Couldn't read this task's skills again.`
              : !held
                ? `${told}Reading the task again, it doesn't have it.`
                : answer.ok && held.rev === answer.selection.revision
                  ? `Attached: reading the task again, it has revision ${esc(held.rev.slice(0, 12))} from its next turn.`
                  : `${told || `The gateway returned revision ${esc(answer.selection.revision.slice(0, 12))}. `}Reading the task again, it has revision ${esc(held.rev.slice(0, 12))}.`;
            // Only the task the write was for shows or announces it.
            if (taskKey() !== sub.key) return;
            const l = $("#k-card-attach");
            if (l) l.innerHTML = `<span>${words}</span>` + (after && !held ? `<button type="button" class="button" data-size="sm" data-k="card-attach" data-rev="${esc(sub.revision)}">Use in this task</button>` : "");
            announce(!after ? "Couldn't read this task's skills again." : held && answer.ok ? "Attached" : "Couldn't attach");
            paintTask();
          });
        });
      }
    }
  });

  // Re-render this page's parts after bots.js changes the access tier.
  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-b="request-write"], [data-b="request-check"]'))
      setTimeout(() => {
        // A new tier: the page reads the entry's canEdit again rather than keep the old tier's.
        if (K.read && K.page && K.page !== "new" && !K.pending) {
          const again = read(K.page);
          if (again.rev === K.read.rev) (K.read.canEdit = again.canEdit), rerender();
        }
        paintTask();
        paintCards();
      }, 0);
  });

  // Prototype controls: what another device or person does on the gateway.
  const extra = $("#proto-extra .run-controls");
  if (extra) {
    extra.insertAdjacentHTML("beforeend", `<button type="button" data-kgw="save">Another device saves trail-checklist</button><button type="button" data-kgw="remove">Another device removes trail-checklist</button>`);
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-kgw]")?.dataset.kgw;
      if (what === "save") otherSave("trail");
      if (what === "remove") gw("trail").removed = true;
    });
  }

  // busy: a write on any of these pages is still waiting for its answer or its read.
  const busy = () => Boolean(K.pending || Object.values(K.tasks).some((v) => v.pending) || K.listPending || K.learnedPending || document.querySelector("#k-card-attach .k-pending"));
  window.skills = { G, K, pins, openPage, read, otherSave, sent, busy };
  paintTask();
  paintCards();
  if (p("section") === "skills" && p("open") === "settings") rerender();
})();
