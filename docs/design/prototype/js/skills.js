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
  // A write's answer arrives after ANSWER ms, and the page's own read after READ ms more.
  const ANSWER = 300;
  const READ = 300;
  const later = (ms, f) => setTimeout(f, ms);
  // Every request the prototype sends, as sent: what a check reads to see what a click captured.
  const sent = [];

  // A revision is a hash of the whole SKILL.md and its files, as on the gateway (research section 3).
  const hash = (text) => {
    let out = "";
    for (let seed = 0; out.length < 64; seed += 1) {
      let h = 0x811c9dc5 ^ seed;
      for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
      out += h.toString(16).padStart(8, "0");
    }
    return out.slice(0, 64);
  };
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
        { name: "rest-stops", description: "Use when a walk is longer than three hours.", files: ["SKILL.md"], live: true, versions: [] },
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
  const visible = (s) => !s.removed && (s.owner === G.profile || s.shared || s.owner === null || isAdmin());
  const mine = (s) => s.owner !== null && s.owner === G.profile;
  const canEdit = (s) => canWrite() && Boolean(G.profile) && (mine(s) || isAdmin());
  // A read of one skill, as skills.library.read returns it, or what the gateway refuses.
  const read = (id) => {
    const s = gw(id);
    if (!s) return { error: "NOT_FOUND" };
    if (s.removed) return { removed: true, slug: s.slug };
    if (!visible(s)) return { error: "NOT_FOUND" };
    return { rev: s.rev, slug: s.slug, description: s.description, body: s.body, extra: [...s.extra], raw: s.raw, files: s.files.map((f) => ({ ...f })), shared: s.shared, enabled: s.enabled, saved: s.saved, owner: s.owner, ownerLabel: s.ownerLabel };
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

  // A task's saved skills: each pin keeps its own revision and that revision's text.
  const pinOf = (id, rev) => {
    const s = gw(id);
    return { skillId: id, rev: rev || s.rev, slug: s.slug, description: s.description, body: s.body };
  };
  const OLD_TRAIL = hash("an earlier trail-checklist");
  const PINS = p("pins");
  const pins = {
    j1:
      PINS === "none"
        ? []
        : [
            { ...pinOf("trail", PINS === "outdated" || PINS === "removed" ? OLD_TRAIL : null), ...(PINS === "outdated" || PINS === "removed" ? { body: "1. Check the forecast.\n2. Pack water." } : {}) },
            pinOf("kitchen"),
            pinOf("weather"),
            ...(PINS === "removed" ? [{ skillId: "gone", rev: hash("gone"), slug: "old-route-notes", description: "Use when you note a route.", body: "Write down the route's turns." }] : []),
            ...(PINS === "unavailable" ? [{ skillId: "elsewhere", rev: hash("elsewhere"), slug: "shared-loop", description: "Use when walking the shared loop.", body: "Go anticlockwise." }] : []),
          ],
    jlearn: [pinOf("kitchen"), pinOf("weather")],
    p1: [pinOf("ridge"), pinOf("kitchen")],
  };
  // On the gateway: "gone" was removed; "elsewhere" was someone else's, no longer shared.
  G.skills.push({ ...skill("gone", "old-route-notes", "Use when you note a route.", "Write down the route's turns."), removed: true });
  G.skills.push({ ...skill("elsewhere", "shared-loop", "Use when walking the shared loop.", "Go anticlockwise.", { owner: "robin", ownerLabel: "Robin Park", shared: false }) });
  // skills.status {agentId, sessionKey}: weather-check's needs aren't met for these tasks.
  const notEligible = new Set(["weather"]);

  const listParam = p("list");
  const selected = app.model.selectedBot;
  if (listParam === "only") G.lists[selected] = [gw("trail").name, "weather"];
  if (listParam === "none") G.lists[selected] = [];
  if (listParam === "unknown") G.lists[selected] = [gw("trail").name, "s_old_route_9b1c2d3e4f5a6b7c8d9e"];
  if (p("learned") === "empty") G.learned.juniper = [];
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
    mode: { save: p("save"), remove: p("remove"), share: p("share"), enable: p("enable"), task: p("taskw"), cfg: p("cfg"), card: p("cardw") },
    pending: null, // the word of a write waiting for its answer or its read: "Saving…"
    status: null, // what the last write's read showed
    compare: null, // {theirs}
    listStatus: null,
    taskView: null,
    taskStatus: null,
    taskPending: null,
    taskRead: {},
    attachOpen: false,
    pinState: PINS === "error" ? "error" : "ready",
    listDraft: null,
    listNote: null,
    listPending: false,
    learnedOpen: p("item") || null,
    learnedNote: null,
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
  const sizeOf = (d) => bytes(markdown({ slug: d.slug || "x", description: d.description, body: d.body, extra: K.read?.extra || [] }));
  const problems = (d) => {
    const out = {};
    if (K.page === "new" && d.slug && !NAME.test(d.slug)) out.name = "Use lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.";
    if (K.page === "new" && !d.slug) out.nameMissing = true;
    if (!d.description.trim()) out.descMissing = true;
    if (/\n/.test(d.description)) out.desc = "Keep Use when… on one line.";
    if (bytes(d.description) > 1024) out.desc = `Too long: ${bytes(d.description).toLocaleString("en-US")} of 1,024 bytes.`;
    if (!d.body.trim()) out.bodyMissing = true;
    if (sizeOf(d) > LIMIT) out.body = "Too long for the gateway: SKILL.md may be at most 1,048,576 bytes, frontmatter included. Letters outside English count as more than one byte.";
    return out;
  };
  const saveable = () => dirty() && !K.pending && !K.gone && online() && Object.keys(problems(K.draft)).length === 0;

  const rev = (r) => `<span class="k-rev mono" aria-label="Revision ${r}" title="${r}">${r.slice(0, 12)}</span>`;
  const tag = (word, tone = "") => `<span class="k-tag"${tone ? ` data-tone="${tone}"` : ""}>${word}</span>`;
  const fact = (k, v) => `<div><dt>${k}</dt><dd class="b-wrap-value">${v}</dd></div>`;
  const backTo = (label, action) => `<button type="button" class="icon-button b-back" data-k="${action}" aria-label="${label}">${icon("back")}</button>`;
  const writeBar = (need) =>
    `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${need}</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`;
  const CONTENT = `<div class="k-content">${icon("list")}<p><b>A skill is instructions a bot follows.</b> A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it.</p></div>`;
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
        : `<p class="b-hint">A task a person starts begins with up to 64 of the skills included in defaults, their own first. A task a bot starts begins with none. A task keeps the revisions it began with until it is updated; see a task's Details.</p>`;
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
      `<p class="${pr.desc ? "b-field-error" : "b-hint"}" id="k-desc-help">${pr.desc || (pr.descMissing ? "Say when a bot should use this skill." : bytes(d.description) >= 900 ? `${bytes(d.description).toLocaleString("en-US")} of 1,024 bytes.` : "When a bot should use it. The gateway shows this to the bot.")}</p></div>` +
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

  function skillPage(s) {
    const r = K.read;
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
    const owner = r.owner === G.profile && r.owner ? "You" : r.owner === null ? "Team" : esc(r.ownerLabel);
    body +=
      `<h4 class="b-group">On the gateway</h4><dl class="facts">` +
      fact("Owner", owner) +
      fact("Revision", rev(r.rev)) +
      fact("Updated", esc(r.saved)) +
      fact("Shared", r.shared ? "Shared on this gateway" : "Not shared") +
      (mine(s) || s.owner === null
        ? `<div class="b-row"><span class="b-row-main"><span>Include in defaults for new tasks</span><small id="k-enabled-line">${
            r.enabled ? "A task a person starts can begin with it, if it is among the first 64 included." : "Tasks don't begin with it. It can still be attached to a task."
          }</small></span>` +
          `<button type="button" class="b-switch" role="switch" aria-checked="${r.enabled}" aria-label="Include in defaults for new tasks" aria-describedby="k-enabled-line" data-k="enable"${editable && !K.pending && !K.gone && online() ? "" : " disabled"}></button></div>`
        : "") +
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
      note(`<p><b>Someone else saved this skill</b> at ${esc(t.saved)}, after you opened it. Your edit isn't saved. Compare them, then choose.</p>`, "warn") +
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
    set("#k-desc-help", pr.desc, pr.descMissing ? "Say when a bot should use this skill." : bytes(d.description) >= 900 ? `${bytes(d.description).toLocaleString("en-US")} of 1,024 bytes.` : "When a bot should use it. The gateway shows this to the bot.");
    set("#k-body-help", pr.body, pr.bodyMissing ? "Write what the bot should do." : "Plain text. Shown to the bot as written.");
    if (K.page === "new") set("#k-slug-help", K.nameTaken && d.slug === K.nameTaken ? `You already have a skill called ${K.nameTaken}. Choose another name.` : pr.name, "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.");
  }

  // Saving (section 5). What is sent is captured at the click: the skill, the base revision,
  // the two fields, and every other part of the skill as the base has it.
  function save({ over = false } = {}) {
    if (K.pending) return;
    if (K.page === "new") return saveNew();
    const base = over ? K.compare.theirs : K.read;
    const sub = { id: K.page, base: base.rev, description: K.draft.description, body: K.draft.body, extra: [...base.extra], files: base.files.map((f) => ({ ...f })) };
    const mode = takeMode("save");
    K.pending = "Saving…";
    K.status = null;
    rerender();
    announce("Saving");
    later(ANSWER, () => {
      const s = gw(sub.id);
      let answer;
      if (mode === "removed") s.removed = true;
      if (mode === "refused") answer = { error: "INVALID_REQUEST", message: "Skill library authority changed. Refresh and retry." };
      else if (mode === "silent") answer = { error: "UNAVAILABLE" };
      else if (s.removed) answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_NOT_FOUND" };
      else if (s.rev !== sub.base) answer = { error: "INVALID_REQUEST", code: "SKILL_LIBRARY_CONFLICT", currentRevision: s.rev };
      else if (mode === "lostnot") answer = null; // the request never reached the gateway
      else {
        const state = commit(s, sub);
        answer = mode === "lost" ? null : { state, rev: s.rev };
        if (mode === "superseded") otherSave(sub.id);
      }
      later(READ, () => settleSave(sub, answer, mode));
    });
  }

  function settleSave(sub, answer, mode) {
    K.pending = null;
    const typedSince = K.draft.description !== sub.description || K.draft.body !== sub.body;
    const r = mode === "readfail" ? { error: "UNAVAILABLE" } : read(sub.id);
    const mineNow = typedSince ? `<p>You typed more after you chose Save. That text is still here, unsaved.</p>` : "";
    const adopt = () => {
      K.read = r;
      if (!typedSince) K.draft = { slug: r.slug, description: r.description, body: r.body };
    };
    if (answer?.error === "INVALID_REQUEST" && answer.code === "SKILL_LIBRARY_CONFLICT") {
      K.compare = { theirs: r };
      announce("Someone else saved this skill");
      rerender();
      return $("#k-theirs", settings())?.scrollIntoView({ block: "nearest" });
    }
    if (answer?.code === "SKILL_LIBRARY_NOT_FOUND" || r.removed) {
      K.status = statusNote(`<p>This skill was removed on the gateway. Your text is still here.</p><div class="b-actions">${button("Save text as a new skill", 'data-k="save-as-new" data-size="sm"')}</div>`, "danger");
      announce("Couldn't save");
      return rerender();
    }
    if (r.error && !answer) {
      K.status = statusNote(`<p>Couldn't tell whether your save reached the gateway, and reading the skill again failed too. Your text is still here, unsaved. The facts below are as read before.</p><div class="b-actions">${button("Read again", 'data-k="reread" data-size="sm"')}</div>`, "warn");
      announce("Couldn't tell whether it was saved");
      return rerender();
    }
    if (answer?.error) {
      K.status = statusNote(
        answer.error === "UNAVAILABLE"
          ? `<p>The gateway answered that it couldn't complete the save, without saying why. It refuses a skill that contains something that looks like a key or a password; if this one has one, take it out. Reading the skill again: revision ${rev(r.rev)}, unchanged. Your text is still here.</p>`
          : `<p>The gateway answered: ${esc(answer.message)} Reading the skill again: revision ${rev(r.rev)}, unchanged. Your text is still here.</p>`,
        "danger",
      );
      announce("Couldn't save");
      return rerender();
    }
    if (!answer) {
      // No answer: say only what the read shows, and keep the text.
      const matches = r.description === sub.description && r.body === sub.body;
      K.read = r;
      K.status = statusNote(
        `<p>Couldn't tell whether your save reached the gateway. Reading the skill again found revision ${rev(r.rev)}, updated ${esc(r.saved)}; its text ${matches ? "matches" : "doesn't match"} what you sent. Which save wrote it isn't known. Your text is still here${matches ? "" : ", unsaved"}.</p>` + mineNow,
        "warn",
      );
      announce("Couldn't tell whether it was saved");
      return rerender();
    }
    if (r.error) {
      K.status = statusNote(`<p>The gateway answered: saved as revision ${rev(answer.rev)}. Reading the skill again failed, so the facts below are as read before.</p><div class="b-actions">${button("Read again", 'data-k="reread" data-size="sm"')}</div>`, "warn");
      announce("Saved, not read back");
      return rerender();
    }
    adopt();
    if (answer.state === "unchanged") {
      K.status = statusNote(`<p>Nothing to save: the gateway already has this text.</p>`);
      announce("Nothing to save");
    } else if (r.rev !== answer.rev) {
      K.status = statusNote(`<p>The gateway answered: saved as revision ${rev(answer.rev)}. Reading it again found revision ${rev(r.rev)}, saved after it; the page shows that one. Yours stays as an earlier revision.</p>` + mineNow, "warn");
      announce("Saved, then changed elsewhere");
    } else {
      K.status = statusNote(
        `<p>Saved revision ${rev(r.rev)}.${r.enabled ? " New tasks that begin with this skill get this revision." : " It isn't included in defaults, so new tasks don't begin with it."} Tasks that have it keep theirs until they are updated.</p>` + mineNow,
      );
      announce("Saved");
    }
    K.compare = null;
    rerender();
    $("#b-section-title", settings())?.focus();
  }

  function saveNew() {
    const sub = { slug: K.draft.slug, description: K.draft.description, body: K.draft.body };
    const mode = takeMode("save");
    K.pending = "Saving…";
    K.status = null;
    rerender();
    announce("Saving");
    later(ANSWER, () => {
      const taken = G.skills.find((s) => !s.removed && mine(s) && s.slug === sub.slug);
      let answer;
      if (taken || mode === "taken") answer = { code: "SKILL_LIBRARY_NAME_CONFLICT" };
      else if (mode === "lostnot") answer = null;
      else {
        const s = skill(`new-${sub.slug}`, sub.slug, sub.description, sub.body, { saved: clock() });
        G.skills.push(s);
        answer = mode === "lost" ? null : { rev: s.rev, id: s.id };
      }
      later(READ, () => {
        K.pending = null;
        if (answer?.code) {
          K.nameTaken = sub.slug;
          announce("Couldn't save");
          rerender();
          return $("#k-slug", settings())?.focus();
        }
        // Read the library again by name.
        const found = G.skills.find((s) => !s.removed && mine(s) && s.slug === sub.slug);
        if (!answer) {
          K.status = found
            ? statusNote(`<p>Couldn't tell whether your save reached the gateway. Reading your library again found a skill named ${esc(sub.slug)}, revision ${rev(found.rev)}; whether your save made it isn't known.</p><div class="b-actions">${button("Open it", `data-k-skill="${found.id}" data-size="sm"`)}</div>`, "warn")
            : statusNote(`<p>Couldn't tell whether your save reached the gateway. Reading your library again found no skill named ${esc(sub.slug)}. Your text is still here.</p>`, "warn");
          announce("Couldn't tell whether it was saved");
          return rerender();
        }
        // What was typed after the click stays, unsaved, on the new skill's page.
        const laterDraft = { ...K.draft };
        const typedSince = laterDraft.description !== sub.description || laterDraft.body !== sub.body;
        K.nameTaken = null;
        K.saveAsNew = false;
        openPage(found.id);
        if (typedSince) K.draft = { slug: found.slug, description: laterDraft.description, body: laterDraft.body };
        K.status = statusNote(
          `<p>Saved revision ${rev(found.rev)}. It is included in defaults, so new tasks a person starts can begin with it.</p>` + (typedSince ? `<p>You typed more after you chose Save. That text is still here, unsaved.</p>` : ""),
        );
        announce("Saved");
        rerender();
        $("#b-section-title", settings())?.focus();
      });
    });
  }

  // Removing (section 7): captured skill and revision; "Removed" only from a read that shows it.
  function remove() {
    const r = K.read;
    const sub = { id: K.page, base: r.rev, slug: r.slug };
    const mode = takeMode("remove");
    K.pending = "Removing…";
    K.status = null;
    rerender();
    announce("Removing");
    later(ANSWER, () => {
      const s = gw(sub.id);
      let answer;
      if (mode === "conflict") otherSave(sub.id);
      if (s.rev !== sub.base) answer = { code: "SKILL_LIBRARY_CONFLICT" };
      else {
        s.removed = true;
        answer = mode === "lost" ? null : { state: "removed" };
      }
      later(READ, () => {
        K.pending = null;
        const after = read(sub.id);
        const kept = dirty(); // unsaved text on the page, against the page's own read
        if (after.removed) {
          const words = `Removed. Reading your library again: ${esc(sub.slug)} isn't in it. Tasks that have it keep their revision.`;
          announce("Removed");
          if (kept) {
            // The draft stays on the removed skill's page; only "Save text as a new skill" can take it.
            K.gone = true;
            K.status = statusNote(`<p>${words} Your unsaved text is still here.</p><div class="b-actions">${button("Save text as a new skill", 'data-k="save-as-new" data-size="sm"')}</div>`, "warn");
            rerender();
            return paintTask();
          }
          K.page = null;
          K.draft = null;
          K.listStatus = statusNote(`<p>${words}</p>`);
          rerender();
          $("#b-section-title", settings())?.focus();
          return paintTask();
        }
        if (answer?.code === "SKILL_LIBRARY_CONFLICT") {
          const words = `<p>The gateway refused this removal because it read a different revision. Reading it again found revision ${rev(after.rev)}.${kept ? " Your unsaved text is still here." : ""}</p>`;
          if (kept) K.compare = { theirs: after };
          else {
            K.read = after;
            K.draft = { slug: after.slug, description: after.description, body: after.body };
          }
          K.status = statusNote(words, "warn");
          announce("Not removed");
          return rerender();
        }
        K.read = after;
        if (!kept) K.draft = { slug: after.slug, description: after.description, body: after.body };
        K.status = statusNote(`<p>Couldn't tell whether it was removed. Reading it again: it is still in your library.</p>`, "warn");
        announce("Not removed");
        rerender();
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
    if (kept) K.compare = { theirs: after };
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

  // How a pin stands against the library, from this read.
  function pinState(x) {
    const s = gw(x.skillId);
    if (!s || !visible(s)) {
      const r = read(x.skillId);
      return r.removed ? { kind: "removed", words: "Removed from the library" } : { kind: "unavailable", words: "Library entry unavailable" };
    }
    if (s.rev !== x.rev) return { kind: "different", words: "Different library revision", lib: s.rev };
    return { kind: "same" };
  }

  function taskSection() {
    const bot = app.model.selectedBot;
    const t = taskKey();
    const list = pins[t];
    if (!list) return "";
    if (K.taskView) return heldView(K.taskView);
    let html = `<section class="work-section k-task" aria-labelledby="k-task-title"><h3 id="k-task-title" tabindex="-1">Skills in this task</h3>`;
    if (K.pinState === "error")
      return html + `<p class="work-note">Couldn't load this task's skills. The gateway answered: Session not found.</p>${button("Try again", 'data-k="pins-retry" data-size="sm"')}</section>`;
    const states = list.map((x) => [x, pinState(x)]);
    const blocked = states.some(([, s]) => s.kind === "removed" || s.kind === "unavailable");
    const different = states.some(([, s]) => s.kind === "different");
    html += `<p class="b-hint k-pins-read">As read at ${K.taskRead[t] || "5:41 PM"}. The skills this task has saved for its next turns, each at its revision.</p>`;
    if (K.taskPending) html += pendingLine(K.taskPending);
    if (different && canWrite())
      html += `<div class="k-update">${button("Update to the library's current revisions", `data-k="refresh" data-size="sm"${blocked || K.taskPending || !online() ? " disabled" : ""}`)}<small>${blocked ? "Detach the skills marked unavailable or removed first: the gateway refuses to update a task that has one." : "Updates every skill in this task."}</small></div>`;
    if (!list.length) html += `<p class="work-note">This task has no skills from your library.</p>`;
    else
      html += `<ul class="k-pins">${states
        .map(([x, st]) => {
          const needs = notEligible.has(x.skillId);
          const tags = [st.kind !== "same" ? tag(st.words, st.kind === "different" ? "" : "warn") : "", needs ? tag("Needs not met") : ""].join("");
          const line = [st.kind === "different" ? `The library has revision ${st.lib.slice(0, 12)}.` : "", needs ? "The gateway says what it needs isn't there, for this task." : ""].filter(Boolean).join(" ");
          return (
            `<li class="k-pin"><button type="button" class="k-pin-open" data-k-pin="${x.skillId}" aria-label="${esc(`${x.slug}, revision ${x.rev.slice(0, 12)}${st.kind !== "same" ? `, ${st.words.toLowerCase()}` : ""}${needs ? ", needs not met" : ""}`)}">` +
            `<span class="k-row-name">${esc(x.slug)}</span>${rev(x.rev)}<span class="k-tags">${tags}</span></button>` +
            (canWrite() ? button("Detach", `data-k="detach" data-value="${x.skillId}" data-size="sm" aria-label="Detach ${esc(x.slug)}"${K.taskPending || !online() ? " disabled" : ""}`, "quiet") : "") +
            (line ? `<small class="k-why">${esc(line)}</small>` : "") +
            `</li>`
          );
        })
        .join("")}</ul>`;
    html += `<p class="b-hint k-filter-line">${esc(botName(bot))}'s skill filter is ${esc(filterWords(bot))}. A filter can leave out a skill this task has; it is set in ${esc(botName(bot))}'s settings, apart from these.</p>`;
    if (canWrite()) {
      const attachable = G.skills.filter((s) => visible(s) && !list.some((x) => x.skillId === s.id));
      html += `<div class="k-attach"><button type="button" class="button" data-size="sm" data-k="attach-open" aria-expanded="${K.attachOpen}"${K.taskPending || !online() ? " disabled" : ""}>Attach a skill</button>`;
      if (K.attachOpen)
        html += attachable.length
          ? `<ul class="k-attach-list" aria-label="Skills to attach">${attachable.map((s) => `<li><button type="button" class="k-attach-item" data-k="attach" data-value="${s.id}"><span class="k-row-name">${esc(s.slug)}</span><small>${esc(s.description)}</small></button></li>`).join("")}</ul>`
          : `<p class="work-note">Every skill in your library is in this task.</p>`;
      html += `</div>`;
    } else html += `<p class="b-hint">Changing a task's skills needs write access.</p>`;
    if (K.taskStatus) html += K.taskStatus;
    return html + `</section>`;
  }

  function heldView(id) {
    const x = pins[taskKey()].find((y) => y.skillId === id);
    return (
      `<section class="work-section k-task k-held" aria-labelledby="k-held-title"><div class="b-subhead">${backTo("Back to details", "held-back")}<h3 id="k-held-title" tabindex="-1">${esc(x.slug)}</h3></div>` +
      CONTENT +
      `<p class="b-hint">Revision ${rev(x.rev)}, the one this task has.</p>` +
      `<p class="k-label">Use when…</p><p class="k-ro">${esc(x.description)}</p><p class="k-label">Instructions</p><pre class="k-plain" data-k-held>${esc(x.body)}</pre></section>`
    );
  }

  function paintTask(focus) {
    const host = $("#panel-details");
    if (!host) return;
    $(".k-task", host)?.remove();
    host.insertAdjacentHTML("beforeend", taskSection());
    if (focus) $(focus, host)?.focus();
  }
  CT.skillsTaskSection = () => paintTask();

  // A task write, captured with its task, skill and revision; the section says what the
  // next read of that task shows (section 9).
  function taskWrite(kind, skillId) {
    const key = taskKey();
    const sub = { key, kind, skillId, rev: skillId ? gw(skillId)?.rev : null };
    const mode = takeMode("task");
    K.taskPending = { refresh: "Updating…", detach: "Detaching…", attach: "Attaching…" }[kind];
    K.taskStatus = null;
    paintTask();
    later(ANSWER, () => {
      const list = pins[sub.key];
      let answer = { ok: true };
      if (mode === "refused") answer = { error: "Session changed before activation; refresh and retry." };
      else {
        if (kind === "refresh") list.forEach((x) => gw(x.skillId) && Object.assign(x, pinOf(x.skillId)));
        if (kind === "detach") pins[sub.key] = list.filter((y) => y.skillId !== sub.skillId);
        if (kind === "attach") list.push(pinOf(sub.skillId, sub.rev));
        if (mode === "lost") answer = null;
      }
      later(READ, () => {
        K.taskPending = null;
        K.taskRead[sub.key] = clock();
        const running = p("running") === "1";
        const after = `${running ? " The turn running now keeps the skills it started with." : ""}`;
        const done = { refresh: "Updated: reading the task again, its skills are at the library's current revisions.", detach: "Detached: reading the task again, it no longer has that skill.", attach: "Attached: reading the task again, it has that skill." }[kind];
        K.taskStatus = answer?.error
          ? `<p class="b-field-error" role="status">The gateway answered: ${esc(answer.error)} Nothing changed; the skills above are as read again.</p>`
          : answer
            ? `<p class="b-hint" role="status">${done} From this task's next turn.${after}</p>`
            : `<p class="b-hint" role="status">Couldn't tell whether the change reached the gateway. The skills above are as read again.${after}</p>`;
        if (sub.key === taskKey()) paintTask();
        announce(answer?.error ? "Couldn't change the task's skills" : answer ? done.split(":")[0] : "Couldn't tell whether it changed");
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
    if (G.defaults === undefined) return "The gateway sets no default, so a bot without its own filter has none: nothing narrows its skills.";
    if (G.defaults.length === 0) return "The gateway's default is none: a bot without its own filter is given no skills from a library or the gateway.";
    return `The gateway's default is only ${G.defaults.map((n) => n).join(", ")}.`;
  }

  function skillsView(bot) {
    const name = esc(botName(bot));
    const saved = G.lists[bot];
    const savedChoice = saved === undefined ? "default" : saved.length ? "only" : "none";
    const d = K.listDraft && K.listDraft.bot === bot ? K.listDraft : { bot, choice: savedChoice, names: [...(saved || [])] };
    K.listDraft = d;
    const dis = isAdmin() && online() ? "" : ' aria-disabled="true"';
    const radio = (value, label, line) =>
      `<li><button type="button" class="b-choice" role="radio" aria-checked="${d.choice === value}" data-k-choice="${value}"${dis}><span class="b-choice-text"><span class="b-choice-title">${label}</span><span class="b-choice-sub b-wrap">${line}</span></span>${icon("check", "icon b-tick")}</button></li>`;
    let html = sub(`${name}'s skills`, "main", "Back to settings");
    html += `<p class="b-hint" style="margin-top:0">A filter narrows the skills ${name} can be given in a task. It doesn't add any: a task is given a library skill only if it has it (see a task's Details), and any skill only if the gateway says what it needs is there.</p>`;
    html += `<h4 class="b-group">${name}'s skill filter</h4>`;
    html +=
      `<ul class="b-choices" role="radiogroup" aria-label="${name}'s skill filter">` +
      radio("default", "Use the gateway's default", esc(defaultWords())) +
      radio("only", "Only these", "The skills checked below, by the names the gateway gives them.") +
      radio("none", "None", `${name} is given no skills from a library or the gateway. Skills ${name} learned bypass the filter.`) +
      `</ul>`;
    if (d.choice === "only") {
      const lib = G.skills.filter((s) => visible(s));
      const box = (value, label) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-k-name="${esc(value)}"${d.names.includes(value) ? " checked" : ""}${isAdmin() && online() ? "" : " disabled"} /> ${label}</label></div>`;
      html += `<p class="k-subgroup">Your library</p><dl class="facts">${lib.map((s) => box(s.name, `<span class="k-box-text"><span>${esc(s.slug)}</span><small class="k-cmd mono">${esc(s.name)}</small></span>`)).join("")}</dl>`;
      html += `<p class="k-subgroup">On the gateway</p><dl class="facts">${GATEWAY_SKILLS.map((n) => box(n, `<span class="mono">${esc(n)}</span>`)).join("")}</dl>`;
      const unknown = d.names.filter((n) => !lib.some((s) => s.name === n) && !GATEWAY_SKILLS.includes(n));
      if (unknown.length)
        html +=
          `<p class="k-subgroup">Not in the gateway's lists now</p><dl class="facts">${unknown.map((n) => `<div class="b-row"><span class="b-row-main"><span class="mono k-cmd-wrap">${esc(n)}</span></span>${isAdmin() && online() ? button("Remove from the filter", `data-k="list-drop" data-value="${esc(n)}" data-size="sm"`, "quiet") : ""}</div>`).join("")}</dl>` +
          `<p class="b-hint">It matches no skill the gateway lists now. A task can still have a skill by this name, and the filter lets that one through.</p>`;
    }
    html += `<p class="b-hint">Skills ${name} learned bypass this filter; the gateway can still leave one out when what it needs isn't there or it is switched off in the gateway's settings. A task can also carry skill overrides of its own on the gateway, which Clawtrate doesn't show. This filter decides what ${name} is given; it doesn't stop ${name}'s commands from reading files.</p>`;
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

  function learnedHtml(bot) {
    const name = esc(botName(bot));
    const all = G.learned[bot] || [];
    const live = all.filter((l) => l.live);
    const archived = all.filter((l) => l.versions.length);
    let html = `<h4 class="b-group">What ${name} learned</h4><p class="b-hint" style="margin-top:0">Skills saved for ${name} on the gateway, by ${name} or by the gateway's review. They bypass the filter above; the gateway still gives one only when what it needs is there.</p>`;
    html += live.length
      ? `<ul class="k-rows">${live.map((l) => `<li><button type="button" class="k-row" data-k-learned="${esc(l.name)}" data-bs="learned"><span class="k-row-main"><span class="k-row-name mono">${esc(l.name)}</span><span class="k-row-when">${esc(l.description)}</span><small class="k-from">${esc(changeLine(bot, l.name))}</small></span>${icon("chevron")}</button></li>`).join("")}</ul>`
      : `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>Nothing learned yet</h4><p>When a skill is saved for ${name}, it shows here.</p></div>`;
    if (archived.length)
      html += `<p class="k-subgroup">Archived</p><dl class="facts">${archived
        .map((l) => `<div class="b-row"><span class="b-row-main"><span class="mono">${esc(l.name)}</span><small>${l.versions.map((v) => `Archived ${esc(v.at)}`).join(" · ")}${l.live ? " · restored since" : ""}</small></span>${isAdmin() && !l.live ? button("Restore", `data-k="restore" data-value="${esc(l.name)}" data-size="sm"${K.learnedPending ? " disabled" : ""}`) : ""}</div>`)
        .join("")}</dl>`;
    if (K.learnedPending) html += pendingLine(K.learnedPending);
    if (K.learnedNote) html += K.learnedNote;
    html += `<dl class="facts" style="margin-top:12px">${fact("Learning on its own", G.mode === "auto" ? "On" : "Off")}</dl><p class="b-hint">The gateway's setting. Its documentation says the gateway can save and update skills after long work and archives ones unused for 30 days. Each change shows here.</p>`;
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
    html += `<p class="b-hint">There is no editor for a learned skill: only the bot's own tool changes it.</p>`;
    if (K.learnedPending) html += pendingLine(K.learnedPending);
    if (K.learnedNote) html += K.learnedNote;
    if (isAdmin() && l.live) html += `<div class="b-actions" style="margin-top:12px">${button("Archive…", `data-k="archive" data-size="sm" data-tone="danger"${K.learnedPending ? " disabled" : ""}`, "quiet")}</div>`;
    return html;
  }

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { skills: skillsView, learned: learnedView });
  CT.botsPageNeeds = Object.assign(CT.botsPageNeeds || {}, {
    skills: (n) => `Changing ${n}'s skill filter changes the gateway's settings. Archiving what ${n} learned needs admin access too.`,
    learned: (n) => `Archiving a skill ${n} learned needs admin access.`,
  });

  const rerenderTab = () => BS.render();

  function saveList(bot) {
    const d = K.listDraft;
    const subm = { bot, value: d.choice === "default" ? undefined : d.choice === "none" ? [] : [...d.names] };
    const mode = takeMode("cfg");
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
        if (mode === "lost") answer = null;
      }
      later(READ, () => {
        K.listPending = false;
        K.listDraft = null; // the page shows what config.get returns now
        const now = rowWord(bot).toLowerCase();
        K.listNote =
          answer?.error && mode === "conflict"
            ? `<div role="status">${note(`<p>Someone else changed ${esc(botName(bot))}'s settings. Nothing was written. This shows what the gateway has now: ${esc(now)}.</p>`, "warn")}</div>`
            : answer?.error
              ? `<div role="status">${note(`<p>The gateway answered: ${esc(answer.error)} Nothing was written; reading again, the filter is ${esc(now)}.</p>`, "danger")}</div>`
              : answer
                ? `<p class="b-hint" role="status">Saved. Reading again, the filter is ${esc(now)}. It applies from each task's next turn; a turn running now keeps the skills it started with.</p>`
                : `<p class="b-hint" role="status">Couldn't tell whether it was saved. Reading again, the filter is ${esc(now)}.</p>`;
        announce(answer?.error ? "Not saved" : answer ? "Saved" : "Couldn't tell whether it was saved");
        rerenderTab();
        paintTask();
      });
    });
  }

  // The cards (section 12): the line under a library save, from a read of this task.
  function paintCards() {
    const line = $("#k-card-attach");
    if (!line || taskKey() !== "jlearn") return;
    const slug = line.dataset.kAttachFor;
    const s = G.skills.find((x) => x.slug === slug && x.id === "trail");
    const held = pins.jlearn.find((x) => x.skillId === s?.id);
    if (!s || !visible(s)) line.innerHTML = `<span>It isn't in your library now, so it can't be attached here.</span>`;
    else if (held) line.innerHTML = `<span>This task has it, revision ${esc(held.rev.slice(0, 12))}.</span>`;
    else if (!canWrite()) line.innerHTML = `<span>This task doesn't have it. Attaching it needs write access.</span>`;
    else line.innerHTML = `<span>This task doesn't have it: a skill saved during a task isn't added to that task.</span><button type="button" class="button" data-size="sm" data-k="card-attach"${online() ? "" : " disabled"}>Use in this task</button>`;
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
    if (box && K.listDraft) {
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
      K.taskView = pin.dataset.kPin;
      return paintTask("#k-held-title");
    }
    const choice = event.target.closest("[data-k-choice]");
    if (choice && isAdmin() && online() && K.listDraft) {
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
        const from = K.taskView;
        K.taskView = null;
        paintTask();
        return $(`[data-k-pin="${from}"]`, $("#panel-details"))?.focus();
      }
      case "pins-retry":
        K.pinState = "ready";
        return paintTask();
      case "refresh":
        return taskWrite("refresh");
      case "detach": {
        const x = pins[taskKey()].find((y) => y.skillId === value);
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
      case "attach-open":
        K.attachOpen = !K.attachOpen;
        paintTask();
        return $('[data-k="attach-open"]', $("#panel-details"))?.focus();
      case "attach":
        K.attachOpen = false;
        return taskWrite("attach", value);
      // A bot's skills
      case "list-save":
        return saveList(bot);
      case "list-drop":
        K.listDraft.names = K.listDraft.names.filter((n) => n !== value);
        return rerenderTab();
      case "archive": {
        const l = (G.learned[bot] || []).find((x) => x.name === K.learnedOpen) || G.learned[bot][0];
        return D.confirmBox({
          title: `Archive ${esc(l.name)}?`,
          text: `${esc(botName(bot))} stops being given it. The gateway keeps it, and you can restore it.`,
          action: "danger",
          label: "Archive",
          run: () => {
            K.learnedPending = "Archiving…";
            rerenderTab();
            later(ANSWER, () => {
              l.live = false;
              l.versions.push({ id: "20261119T150206000Z-archive", at: clock() });
              G.changes[bot].unshift({ skill: l.name, action: "archive", actor: "user", at: l.versions.at(-1).at });
              later(READ, () => {
                K.learnedPending = null;
                BS.S.view = "skills";
                const archived = !l.live;
                K.learnedNote = `<p class="b-hint" role="status">${archived ? `Archived. Reading again, ${esc(l.name)} is in Archived.` : "Reading again, it is still live."}</p>`;
                rerenderTab();
                announce("Archived");
              });
            });
          },
        });
      }
      case "restore": {
        const l = (G.learned[bot] || []).find((x) => x.name === value);
        K.learnedPending = "Restoring…";
        rerenderTab();
        return later(ANSWER, () => {
          l.live = true;
          G.changes[bot].unshift({ skill: l.name, action: "restore", actor: "user", at: clock() });
          later(READ, () => {
            K.learnedPending = null;
            K.learnedNote = `<p class="b-hint" role="status">Restored. Reading again, ${esc(l.name)} is live for ${esc(botName(bot))}.</p>`;
            rerenderTab();
            announce("Restored");
          });
        });
      }
      // The cards
      case "card-open":
        openPage("trail");
        return D.openSettings(t, "skills");
      case "card-learned":
        K.learnedOpen = "trail-checklist";
        return CT.botsOpenSettings ? CT.botsOpenSettings("juniper", "learned") : null;
      case "card-attach": {
        const line = $("#k-card-attach");
        const sub = { key: "jlearn", skillId: "trail", rev: gw("trail").rev };
        const mode = takeMode("card");
        line.innerHTML = `<span class="k-pending"><span class="status-dot" data-status="connecting"></span>Attaching…</span>`;
        return later(ANSWER, () => {
          if (mode !== "refused") pins[sub.key].push(pinOf(sub.skillId, sub.rev));
          later(READ, () => {
            const held = pins[sub.key].find((x) => x.skillId === sub.skillId);
            if (taskKey() === sub.key) {
              const l = $("#k-card-attach");
              if (l)
                l.innerHTML = held
                  ? `<span>Attached: reading the task again, it has revision ${esc(held.rev.slice(0, 12))} from its next turn.</span>`
                  : `<span>The gateway answered: Session changed before activation; refresh and retry. Reading the task again, it doesn't have it.</span><button type="button" class="button" data-size="sm" data-k="card-attach">Use in this task</button>`;
            }
            announce(held ? "Attached" : "Couldn't attach");
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

  window.skills = { G, K, pins, openPage, read, otherSave, sent };
  paintTask();
  paintCards();
  if (p("section") === "skills" && p("open") === "settings") rerender();
})();
