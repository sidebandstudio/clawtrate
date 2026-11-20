// Skills (docs/design/skills.md): the library in Settings, a skill's page and
// its saves, a new skill, removing and sharing, the skills a task holds, a
// bot's skills and what it learned, and the cards of a bot saving a skill.
// On top of bots.js, bot-settings.js and t3.js. Nothing here talks to a
// gateway: "the gateway" is the object G below, and each page shows only what
// it last read from G. Every state comes from the address (skills.md, section 16).

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { B, button, note, announce } = D;
  const BS = window.botSettings;
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const canWrite = () => B.access !== "read";
  const isAdmin = () => B.access === "admin";
  let minute = 41;
  const clock = () => `5:${String(minute++).padStart(2, "0")} PM`;

  // A revision is a hash of the content, as on the gateway (research section 3).
  const hash = (text) => {
    let out = "";
    for (let seed = 0; out.length < 64; seed += 1) {
      let h = 0x811c9dc5 ^ seed;
      for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
      out += h.toString(16).padStart(8, "0");
    }
    return out.slice(0, 64);
  };
  const markdown = (s) => `---\nname: ${s.slug}\ndescription: ${s.description}\n---\n\n${s.body}\n`;
  const commandName = (slug, id) => `s_${slug.replace(/-+/g, "_").slice(0, 9).replace(/_+$/, "")}_${hash(id).slice(0, 20)}`;
  const LIMIT = 1048576;
  const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

  // The gateway ----------------------------------------------------------------------------------

  const ME = "gateway-owner";
  const skill = (id, slug, description, body, extra = {}) => {
    const s = { id, slug, description, body, owner: ME, ownerLabel: "Sam Lee", shared: false, enabled: true, removed: false, files: [], needs: null, saved: "5:38 PM", ...extra };
    s.rev = hash(markdown(s));
    s.name = commandName(slug, id);
    return s;
  };
  const G = {
    profile: p("lib") === "noprofile" ? null : ME,
    multi: p("multi") === "1",
    skills: [
      skill("trail", "trail-checklist", "Use when planning a weekend walk, to check the weather, the route and what to pack.", "1. Check the forecast for the day of the walk.\n2. Choose the route and note its length.\n3. Pack water, a map and a warm layer.", { saved: "2:51 PM" }),
      skill("kitchen", "kitchen-timer", "Use when timing a recipe.", "Run scripts/timer.sh with the minutes.\nRead references/times.md for common times.", {
        files: [
          { path: "references/times.md", size: "18 bytes", exec: false },
          { path: "scripts/timer.sh", size: "44 bytes", exec: true },
        ],
      }),
      skill("weather", "weather-check", "Use when asked about the weather for a walk.", "Call https://weather.example/forecast with curl and $WEATHER_API_KEY, then say the forecast in one line.", { needs: { bins: ["curl"], env: ["WEATHER_API_KEY"] } }),
      skill("pack", "pack-list", "Use when packing for a trip of more than one night.", "Pack light. List what to bring by day, then cut a third.", { enabled: false }),
      skill("ridge", "ridge-safety", "Use when a walk goes above the tree line.", "Turn back if the wind is too strong to stand still in.", { owner: null, ownerLabel: "Team", shared: true }),
    ],
    lists: {}, // a bot's agents.entries.<id>.skills; a bot without a key gets every skill
    learned: {
      juniper: [{ name: "trail-checklist", description: "Use when planning a weekend walk, to check the weather, the route and what to pack.", text: "", files: ["SKILL.md"], live: true, versions: [] }],
    },
    changes: { juniper: [{ skill: "trail-checklist", action: "create", actor: "agent", task: "Weekend walk checklist", at: "3:04 PM" }] },
    mode: "auto",
  };
  if (G.multi) G.skills.push(skill("river", "river-crossing", "Use when a trail crosses a river.", "Unbuckle the hip belt and face upstream.", { owner: "robin", ownerLabel: "Robin Park", shared: true }));
  G.learned.juniper[0].text = markdown({ slug: "trail-checklist", description: G.learned.juniper[0].description, body: G.skills[0].body });
  const gw = (id) => G.skills.find((s) => s.id === id);
  const mine = (s) => s.owner !== null && s.owner === G.profile;
  const canEdit = (s) => canWrite() && Boolean(G.profile) && (mine(s) || isAdmin());

  // A task's pins: Juniper's "Heat pump vs. gas furnace" (j1) and the checklist task.
  const pinOf = (id, rev) => ({ id, rev: rev || gw(id).rev });
  const OLD_TRAIL = hash("an earlier trail-checklist");
  const PINS = p("pins");
  const pins = {
    j1: PINS === "none" ? [] : [pinOf("trail", PINS === "outdated" || PINS === "removed" ? OLD_TRAIL : null), pinOf("kitchen"), pinOf("weather"), ...(PINS === "removed" ? [{ id: "gone", rev: hash("gone"), slug: "old-route-notes", removed: true }] : [])],
    jlearn: [pinOf("kitchen"), pinOf("weather")],
  };
  // The gateway judged weather-check's needs not met for Juniper (skills.status eligible: false).
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
    read: null, // the page's last read of the skill: {rev, description, body, files}
    draft: null,
    saveMode: p("save"),
    status: null, // a line under the page's head after a write
    compare: null, // {theirs}
    taskView: null, // a held revision opened from the Details tab
    taskNote: null,
    attachOpen: false,
    pinState: PINS === "error" ? "error" : "ready",
    listDraft: null,
    listNote: null,
    cfgMode: p("cfg"),
    learnedOpen: p("item") || null,
    learnedNote: null,
    cardAttached: false,
  };
  if (K.lib === "empty") G.skills = G.skills.filter((s) => !mine(s));
  if (K.lib === "many") for (let i = 0; i < 62; i += 1) G.skills.push(skill(`x${i}`, `route-note-${i + 1}`, "Use when a route needs a note.", "Write the note."));

  function openPage(id) {
    K.page = id;
    K.status = null;
    K.compare = null;
    if (id === "new") {
      K.read = null;
      K.draft = { slug: "", description: "", body: p("big") === "1" ? "x".repeat(LIMIT) : "" };
      return;
    }
    const s = gw(id);
    if (!s) return;
    K.read = { rev: s.rev, description: s.description, body: s.body, saved: s.saved };
    K.draft = { slug: s.slug, description: s.description, body: s.body };
    // save=conflict: another device saves this skill after the page read it.
    if (K.saveMode === "conflict") otherSave(id), (K.saveMode = null);
  }
  function otherSave(id) {
    const s = gw(id);
    s.body = s.body.replace("Pack water, a map and a warm layer.", "Pack water, a map, a warm layer and a head torch.");
    s.rev = hash(markdown(s));
    s.saved = "5:44 PM";
  }
  if (K.page) openPage(K.page);

  const dirty = () => {
    if (!K.draft) return false;
    if (K.page === "new") return Boolean(K.draft.slug || K.draft.description || K.draft.body);
    return K.draft.description !== K.read.description || K.draft.body !== K.read.body;
  };
  const sizeOf = (d) => markdown({ slug: d.slug || "x", description: d.description, body: d.body }).length;
  const problems = (d) => {
    const out = {};
    if (K.page === "new" && d.slug && !NAME.test(d.slug)) out.name = "Use lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.";
    if (K.page === "new" && !d.slug) out.nameMissing = true;
    if (!d.description.trim()) out.descMissing = true;
    if (d.description.length > 1024) out.desc = `Too long: ${d.description.length.toLocaleString("en-US")} of 1,024 characters.`;
    if (!d.body.trim()) out.bodyMissing = true;
    if (sizeOf(d) > LIMIT) out.body = "Too long for the gateway: 1,048,576 characters at most, frontmatter included.";
    return out;
  };
  const saveable = () => {
    if (!dirty() || K.saving) return false;
    return Object.keys(problems(K.draft)).length === 0;
  };

  const rev = (r) => `<span class="k-rev mono" aria-label="Revision ${r}" title="${r}">${r.slice(0, 12)}</span>`;
  const tag = (word, tone = "") => `<span class="k-tag"${tone ? ` data-tone="${tone}"` : ""}>${word}</span>`;
  const fact = (k, v) => `<div><dt>${k}</dt><dd>${v}</dd></div>`;
  const backTo = (label, action) => `<button type="button" class="icon-button b-back" data-k="${action}" aria-label="${label}">${icon("back")}</button>`;
  const writeBar = (need) =>
    `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${need}</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`;
  const CONTENT = `<div class="k-content">${icon("list")}<p><b>A skill is instructions a bot follows.</b> A bot given this skill can act on what it says, with the tools it is allowed. Read it before your bots are given it.</p></div>`;

  // Settings, Skills (section 3) ------------------------------------------------------------------

  D.B && CT.botsSections.splice(CT.botsSections.findIndex(([id]) => id === "accounts") + 1, 0, ["skills", "Skills"]);
  CT.botsSectionViews = CT.botsSectionViews || {};
  CT.botsSectionViews.skills = ({ back }) => {
    if (K.page === "new") return newPage();
    if (K.page && gw(K.page)) return skillPage(gw(K.page));
    return libraryList(back);
  };

  function row(s) {
    const tags = [!s.enabled ? tag("Off") : "", mine(s) && s.shared ? tag("Shared") : "", s.owner === null ? tag("Team") : ""].join("");
    const from = mine(s) ? "" : s.owner === null ? "" : `<small class="k-from">From ${esc(s.ownerLabel)}</small>`;
    const spoken = [s.slug, s.description, !s.enabled ? "off" : "", mine(s) && s.shared ? "shared" : "", s.owner === null ? "team" : mine(s) ? "" : `from ${s.ownerLabel}`].filter(Boolean).join(", ");
    return `<li><button type="button" class="k-row" data-k-skill="${s.id}" aria-label="${esc(spoken)}"><span class="k-row-main"><span class="k-row-name">${esc(s.slug)}</span><span class="k-row-when">${esc(s.description)}</span>${from}</span><span class="k-tags">${tags}</span>${icon("chevron")}</button></li>`;
  }

  function libraryList(back) {
    const lead = G.multi
      ? "Skills you keep on this gateway. Your bots are given them in new tasks. Skills are yours on this gateway; other people of this gateway have their own."
      : "Skills you keep on this gateway. Your bots are given them in new tasks. Every device of yours connected to this gateway sees the same skills.";
    const head = `<div class="b-headrow"><p class="b-lead" style="margin:0;text-align:left">${lead}</p>${canWrite() && G.profile && K.lib !== "loading" && K.lib !== "error" ? button("New skill", 'data-k="new" data-size="sm"') : ""}</div>`;
    const foot = canWrite() ? "" : writeBar("Changing skills needs write access.");
    if (K.lib === "loading") return { title: "Skills", back, body: head + `<div aria-busy="true" aria-label="Loading skills">${'<div class="skeleton" style="height:58px;width:100%;margin-top:10px"></div>'.repeat(3)}</div>`, foot };
    if (K.lib === "error")
      return { title: "Skills", back, body: head + `<div class="work-empty"><span class="empty-mark">${icon("warning")}</span><h4>Couldn't load your skills</h4><p>The gateway answered: Unable to complete the skill library operation. Review the bundle or retry the request.</p><div style="margin-top:10px">${button("Try again", 'data-k="lib-retry" data-size="sm"')}</div></div>`, foot };
    if (!G.profile)
      return { title: "Skills", back, body: head + `<div class="work-empty"><span class="empty-mark">${icon("lock")}</span><h4>No library for this connection</h4><p>This connection has no profile on the gateway, so it has no library. The gateway gives a library to a signed-in person.</p></div>`, foot };
    const own = G.skills.filter((s) => !s.removed && mine(s));
    const others = G.skills.filter((s) => !s.removed && !mine(s) && (s.shared || s.owner === null));
    let body = head + (K.status || "");
    if (!own.length)
      body += `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>No skills yet</h4><p>A skill is a process you want a bot to follow, written once. Save one here, or ask a bot to save what it just did.</p>${canWrite() ? `<div style="margin-top:12px">${button("New skill", 'data-k="new"', "primary")}</div>` : ""}</div>`;
    else body += `<h4 class="b-group">Your skills</h4><ul class="k-rows">${own.map(row).join("")}</ul>`;
    if (others.length) body += `<h4 class="b-group">Shared on this gateway</h4><ul class="k-rows">${others.map(row).join("")}</ul>`;
    const on = G.skills.filter((s) => !s.removed && s.enabled && (mine(s) || s.shared || s.owner === null)).length;
    body +=
      on > 64
        ? note(`<p>New sessions select up to 64 enabled skills, personal skills first and then stable ID order. In a session, detach a selected skill to make room and attach another from the library.</p>`, "warn")
        : `<p class="b-hint">New tasks start with every skill that is on, up to 64, your own first. A task keeps the revision it started with; see a task's Details.</p>`;
    body += `<p class="b-hint k-readat">As read at ${K.readAt}. ${`<button type="button" class="link-button" data-k="lib-read">Read again</button>`}</p>`;
    return { title: "Skills", back, body, foot };
  }

  // A skill's page (sections 4, 5, 7, 8) -----------------------------------------------------------

  function fieldsHtml(s, editable) {
    const d = K.draft;
    const pr = problems(d);
    const ro = editable ? "" : " readonly";
    return (
      `<div class="k-field"><label class="k-label" for="k-desc">Use when…</label><input class="input" id="k-desc" data-k-field="description" maxlength="1100" value="${esc(d.description)}"${ro} aria-describedby="k-desc-help" />` +
      `<p class="${pr.desc ? "b-field-error" : "b-hint"}" id="k-desc-help">${pr.desc || (pr.descMissing && editable ? "Say when a bot should use this skill." : d.description.length >= 900 ? `${d.description.length.toLocaleString("en-US")} of 1,024 characters.` : "When a bot should use it. The gateway shows this to the bot.")}</p></div>` +
      `<div class="k-field"><label class="k-label" for="k-body">Instructions</label><textarea class="input k-editor" id="k-body" data-k-field="body" rows="12" spellcheck="false"${ro} aria-describedby="k-body-help">${esc(d.body)}</textarea>` +
      `<p class="${pr.body ? "b-field-error" : "b-hint"}" id="k-body-help">${pr.body || (pr.bodyMissing && editable ? "Write what the bot should do." : "Plain text. Shown to the bot as written.")}</p></div>`
    );
  }

  function filesHtml(s) {
    if (!s.files.length) return "";
    return (
      `<h4 class="b-group">Files</h4><dl class="facts">${s.files.map((f) => `<div><dt class="mono">${esc(f.path)}</dt><dd>${esc(f.size)}${f.exec ? ` · ${tag("Can run as a program")}` : ""}</dd></div>`).join("")}</dl>` +
      `<p class="b-hint">Kept with every save. A bot runs a file only with the tools it is allowed. Editing files isn't in this version.</p>`
    );
  }
  function needsHtml(s) {
    if (!s.needs) return "";
    return `<h4 class="b-group">Needs</h4><p class="k-needs">Programs: <span class="mono">${s.needs.bins.map(esc).join(", ")}</span>. Values: <span class="mono">${s.needs.env.map(esc).join(", ")}</span>.</p><p class="b-hint">From the skill's own text. The gateway gives a skill to a bot only when what it needs is there.</p>`;
  }

  function skillPage(s) {
    const editable = canEdit(s) && !s.removed;
    let body = CONTENT + (K.status || "");
    if (K.compare) body += compareHtml(s);
    body += `<div class="k-field"><span class="k-label">Name</span><p class="k-name mono" id="k-name">${esc(s.slug)}</p><p class="b-hint">A skill's name is set when it is made.</p></div>`;
    if (!K.compare) body += fieldsHtml(s, editable);
    body += filesHtml(s) + needsHtml(s);
    const owner = mine(s) ? "You" : s.owner === null ? "Team" : esc(s.ownerLabel);
    body +=
      `<h4 class="b-group">On the gateway</h4><dl class="facts">` +
      fact("Owner", owner) +
      fact("Revision", rev(K.read.rev)) +
      fact("Saved", esc(K.read.saved)) +
      fact("Shared", s.shared ? "Shared on this gateway" : "Only you") +
      (mine(s) || s.owner === null
        ? `<div class="b-row"><span class="b-row-main"><span>New tasks start with it</span><small id="k-enabled-line">${s.enabled ? "New tasks start with it." : "New tasks don't start with it. A task can still attach it."}</small></span>` +
          `<button type="button" class="b-switch" role="switch" aria-checked="${s.enabled}" aria-label="New tasks start with it" aria-describedby="k-enabled-line" data-k="enable"${editable && !K.busy ? "" : " disabled"}${K.busy === "enable" ? ' aria-busy="true"' : ""}></button></div>`
        : "") +
      `</dl>`;
    if (mine(s) && editable) {
      const multiLine = G.multi ? "" : `<p class="b-hint">No one else has a profile on this gateway yet, so no one else sees it.</p>`;
      body += s.shared
        ? `<p class="b-hint">Shared on this gateway. Their tasks that have it keep it when you stop sharing.</p>${multiLine}`
        : `<p class="b-hint">Other people of this gateway can then see it and their new tasks start with it. Nothing leaves the gateway.</p>${multiLine}`;
    }
    if (!mine(s) && !editable && canWrite()) body += `<p class="b-hint">Only the skill's owner or a Gateway administrator can change it.</p>`;
    const foot = !canWrite()
      ? writeBar("Changing skills needs write access.")
      : editable && !K.compare
        ? `<div class="b-actions k-foot">${button(K.saving ? "Saving…" : "Save", `data-k="save" data-size="sm"${saveable() ? "" : " disabled"}`, "primary")}<span class="spacer"></span>` +
          (mine(s) ? button(s.shared ? "Stop sharing" : "Share on this gateway", `data-k="share" data-size="sm"${K.busy ? " disabled" : ""}`) : "") +
          button("Remove skill…", 'data-k="remove" data-size="sm" data-tone="danger"', "quiet") +
          `</div>`
        : "";
    return { title: esc(s.slug), back: backTo("Back to skills", "to-list"), body, foot };
  }

  function compareHtml(s) {
    const t = K.compare.theirs;
    return (
      note(`<p><b>Someone else saved this skill</b> at ${esc(t.saved)}, after you opened it. Your edit isn't saved. Compare them, then choose.</p>`, "warn") +
      `<div class="k-compare">` +
      `<section aria-labelledby="k-theirs"><h4 class="b-group" id="k-theirs">On the gateway now</h4><p class="b-hint">Revision ${rev(t.rev)}, saved ${esc(t.saved)}</p><p class="k-label">Use when…</p><p class="k-ro">${esc(t.description)}</p><p class="k-label">Instructions</p><pre class="k-plain" data-k-theirs>${esc(t.body)}</pre></section>` +
      `<section aria-labelledby="k-mine"><h4 class="b-group" id="k-mine">Your edit</h4>${fieldsHtml(s, true)}</section>` +
      `</div>` +
      `<p class="b-hint">Theirs stays as an earlier revision on the gateway.</p>` +
      `<div class="b-actions">${button("Save my edit", 'data-k="save-mine" data-size="sm"', "primary")}${button("Use theirs", 'data-k="use-theirs" data-size="sm"')}</div>`
    );
  }

  function newPage() {
    const d = K.draft;
    const pr = problems(d);
    let body = CONTENT + (K.status || "");
    body +=
      `<div class="k-field"><label class="k-label" for="k-slug">Name</label><input class="input mono" id="k-slug" data-k-field="slug" maxlength="80" value="${esc(d.slug)}" autocomplete="off" spellcheck="false" aria-describedby="k-slug-help" data-b-focus />` +
      `<p class="${pr.name || K.nameTaken ? "b-field-error" : "b-hint"}" id="k-slug-help">${K.nameTaken ? `You already have a skill called ${esc(K.nameTaken)}. Choose another name.` : pr.name || "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters."}</p></div>`;
    body += fieldsHtml(null, true);
    const foot = `<div class="b-actions k-foot">${button(K.saving ? "Saving…" : "Save", `data-k="save" data-size="sm"${saveable() && !K.nameTaken ? "" : " disabled"}`, "primary")}</div>`;
    return { title: "New skill", back: backTo("Back to skills", "to-list"), body, foot };
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
    const set = (id, error, hint) => {
      const el = $(id, settings());
      if (!el) return;
      el.className = error ? "b-field-error" : "b-hint";
      el.textContent = error || hint;
    };
    set("#k-desc-help", pr.desc, pr.descMissing ? "Say when a bot should use this skill." : d.description.length >= 900 ? `${d.description.length.toLocaleString("en-US")} of 1,024 characters.` : "When a bot should use it. The gateway shows this to the bot.");
    set("#k-body-help", pr.body, pr.bodyMissing ? "Write what the bot should do." : "Plain text. Shown to the bot as written.");
    if (K.page === "new") set("#k-slug-help", K.nameTaken && d.slug === K.nameTaken ? `You already have a skill called ${K.nameTaken}. Choose another name.` : pr.name, "Lowercase letters, digits and hyphens, starting with a letter or digit, up to 63 characters.");
  }

  const statusNote = (html, tone = "") => (tone ? note(html, tone) : `<div class="k-status" role="status">${icon("check")}<div>${html}</div></div>`);

  function save({ over = false } = {}) {
    if (K.saving) return;
    const mode = K.saveMode;
    K.saveMode = null;
    K.saving = true;
    K.status = null;
    rerender();
    announce("Saving");
    setTimeout(() => {
      K.saving = false;
      const d = K.draft;
      if (K.page === "new") return saveNew(mode);
      const s = gw(K.page);
      const done = (words) => {
        K.status = statusNote(words);
        K.read = { rev: s.rev, description: s.description, body: s.body, saved: s.saved };
        rerender();
        $("#b-section-title", settings())?.focus();
      };
      // save=removed: another device removed the skill after the page read it.
      if (mode === "removed") s.removed = true;
      if (s.removed) {
        K.status = note(`<p>This skill was removed on the gateway. Your text is still here.</p><div class="b-actions">${button("Save as a new skill", 'data-k="save-as-new" data-size="sm"')}</div>`, "danger");
        announce("Couldn't save");
        return rerender();
      }
      if (mode === "refused") {
        K.status = note(`<p>The gateway answered: Skill library authority changed. Refresh and retry. Nothing was saved.</p>`, "danger");
        announce("Couldn't save");
        return rerender();
      }
      if (mode === "silent") {
        K.status = note(`<p>The gateway didn't save this skill and didn't say why. It refuses a skill that contains something that looks like a key or a password; if this one has one, take it out. Nothing was saved.</p>`, "danger");
        announce("Couldn't save");
        return rerender();
      }
      if (mode === "unchanged") {
        K.status = statusNote(`<p>Nothing to save: the gateway already has this text.</p>`);
        announce("Nothing to save");
        return rerender();
      }
      // The compare-and-set: the page's revision against the gateway's.
      const base = over ? K.compare.theirs.rev : K.read.rev;
      if (base !== s.rev) {
        K.compare = { theirs: { rev: s.rev, description: s.description, body: s.body, saved: s.saved } };
        K.status = null;
        announce("Someone else saved this skill");
        rerender();
        return $("#k-theirs", settings())?.scrollIntoView({ block: "nearest" });
      }
      const apply = () => {
        const before = s.rev;
        s.description = d.description;
        s.body = d.body;
        s.rev = hash(markdown(s));
        s.saved = clock();
        K.compare = null;
        if (s.rev === before) return done(`<p>Nothing to save: the gateway already has this text.</p>`), announce("Nothing to save");
        done(`<p>Saved. New tasks start with revision ${rev(s.rev)}. Tasks that have this skill keep theirs until they are updated.</p>`);
        announce("Saved");
      };
      if (mode === "lost") {
        K.status = note(`<p>Couldn't tell whether it was saved. Reading the skill again…</p>`, "warn");
        rerender();
        return setTimeout(() => {
          apply();
          K.status = statusNote(`<p>Checked: the gateway has your text. Saved as revision ${rev(s.rev)}.</p>`);
          rerender();
        }, 700);
      }
      apply();
    }, 300);
  }

  function saveNew(mode) {
    const d = K.draft;
    const taken = G.skills.find((s) => !s.removed && mine(s) && s.slug === d.slug);
    if (taken || mode === "taken") {
      K.nameTaken = d.slug;
      announce("Couldn't save");
      rerender();
      return $("#k-slug", settings())?.focus();
    }
    const id = `new-${d.slug}`;
    const s = skill(id, d.slug, d.description, d.body, { saved: clock() });
    G.skills.push(s);
    K.nameTaken = null;
    openPage(id);
    K.status = statusNote(`<p>Saved. New tasks start with it. Revision ${rev(s.rev)}.</p>`);
    announce("Saved");
    rerender();
    $("#b-section-title", settings())?.focus();
  }

  // Skills in this task (section 9) --------------------------------------------------------------

  const taskId = () => app.model.selectedTask;
  const listOf = (bot) => G.lists[bot];
  function given(pin, bot) {
    const s = gw(pin.id);
    const list = listOf(bot);
    if (list && !list.includes(s?.name || pin.slug)) return `${botName(bot)}'s skill list doesn't include it.`;
    if (notEligible.has(pin.id)) return "The gateway says what it needs isn't there.";
    return null;
  }

  function taskSection() {
    const bot = app.model.selectedBot;
    const t = taskId();
    const list = pins[t];
    if (!list || bot !== "juniper") return "";
    if (K.taskView) return heldView(K.taskView, bot);
    let html = `<section class="work-section k-task" aria-labelledby="k-task-title"><h3 id="k-task-title" tabindex="-1">Skills in this task</h3>`;
    if (K.pinState === "error")
      return html + `<p class="work-note">Couldn't load this task's skills. The gateway answered: Session not found.</p>${button("Try again", 'data-k="pins-retry" data-size="sm"')}</section>`;
    const outdated = list.some((x) => !x.removed && gw(x.id) && gw(x.id).rev !== x.rev);
    const removed = list.some((x) => x.removed || gw(x.id)?.removed);
    if (outdated && canWrite())
      html += `<div class="k-update">${button("Update to the latest revisions", `data-k="refresh" data-size="sm"${removed ? " disabled" : ""}`)}<small>${removed ? "Detach removed skills first." : "Updates every skill in this task."}</small></div>`;
    if (!list.length) html += `<p class="work-note">This task has no skills from your library.</p>`;
    else
      html += `<ul class="k-pins">${list
        .map((x) => {
          const s = gw(x.id);
          const isRemoved = x.removed || s?.removed;
          const slug = s?.slug || x.slug;
          const why = isRemoved ? null : given(x, bot);
          const tags = [isRemoved ? tag("Removed", "warn") : s.rev !== x.rev ? tag("Newer revision") : "", why ? tag("Not given") : ""].join("");
          return (
            `<li class="k-pin"><button type="button" class="k-pin-open" data-k-pin="${x.id}" aria-label="${esc(`${slug}, revision ${x.rev.slice(0, 12)}${isRemoved ? ", removed" : s.rev !== x.rev ? ", newer revision saved" : ""}${why ? `, not given: ${why}` : ""}`)}">` +
            `<span class="k-row-name">${esc(slug)}</span>${rev(x.rev)}<span class="k-tags">${tags}</span></button>` +
            (canWrite() ? button("Detach", `data-k="detach" data-value="${x.id}" data-size="sm" aria-label="Detach ${esc(slug)}"`, "quiet") : "") +
            (why ? `<small class="k-why">${esc(why)}</small>` : "") +
            `</li>`
          );
        })
        .join("")}</ul>`;
    if (canWrite()) {
      const attachable = G.skills.filter((s) => !s.removed && (mine(s) || s.shared || s.owner === null) && !list.some((x) => x.id === s.id));
      html += `<div class="k-attach"><button type="button" class="button" data-size="sm" data-k="attach-open" aria-expanded="${K.attachOpen}">Attach a skill</button>`;
      if (K.attachOpen)
        html += attachable.length
          ? `<ul class="k-attach-list" aria-label="Skills to attach">${attachable.map((s) => `<li><button type="button" class="k-attach-item" data-k="attach" data-value="${s.id}"><span class="k-row-name">${esc(s.slug)}</span><small>${esc(s.description)}</small></button></li>`).join("")}</ul>`
          : `<p class="work-note">Every skill in your library is in this task.</p>`;
      html += `</div>`;
    }
    if (K.taskNote) html += `<p class="b-hint" role="status">${K.taskNote}</p>`;
    if (!canWrite()) html += `<p class="b-hint">Changing a task's skills needs write access.</p>`;
    return html + `</section>`;
  }

  function heldView(id, bot) {
    const x = pins[taskId()].find((y) => y.id === id);
    const s = gw(id);
    const slug = s?.slug || x.slug;
    const body = s && x.rev === s.rev ? s : s ? { ...s, body: "1. Check the forecast for the day of the walk.\n2. Pack water and a map." } : { description: "Use when you note a route.", body: "Write down the route's turns." };
    return (
      `<section class="work-section k-task k-held" aria-labelledby="k-held-title"><div class="b-subhead">${backTo("Back to details", "held-back")}<h3 id="k-held-title" tabindex="-1">${esc(slug)}</h3></div>` +
      CONTENT +
      `<p class="b-hint">Revision ${rev(x.rev)}, the one this task has.</p>` +
      `<p class="k-label">Use when…</p><p class="k-ro">${esc(body.description)}</p><p class="k-label">Instructions</p><pre class="k-plain">${esc(body.body)}</pre></section>`
    );
  }

  function paintTask(focusTitle) {
    const host = $("#panel-details");
    if (!host) return;
    $(".k-task", host)?.remove();
    host.insertAdjacentHTML("beforeend", taskSection());
    if (focusTitle) $(focusTitle, host)?.focus();
  }
  CT.skillsTaskSection = () => paintTask();

  function taskWrite(words, change) {
    K.taskNote = null;
    paintTask();
    setTimeout(() => {
      change();
      const running = p("running") === "1";
      K.taskNote = `${words} From the next turn.${running ? " The turn running now keeps the skills it started with." : ""}`;
      paintTask();
      announce(words.replace(/\.$/, ""));
    }, 250);
  }

  // A bot's skills (section 10) ------------------------------------------------------------------

  const listWord = (bot) => {
    const l = listOf(bot);
    return l === undefined ? "Every skill" : l.length === 0 ? "None" : `Only ${l.length}`;
  };
  CT.botsToolsRows = (id) =>
    `<div><dt>Permissions</dt><dd>Ask before running commands</dd></div>` +
    `<div><button type="button" class="b-open" data-bs="skills"><span>Skills</span><span class="b-open-value">${listWord(id)}</span>${icon("chevron")}</button></div>`;
  const sub = (title, to, label) =>
    `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="${to}" aria-label="${label}">${icon("back")}</button><h3 tabindex="-1" data-bs-focus>${title}</h3></div>`;

  function skillsView(bot) {
    const name = esc(botName(bot));
    const saved = listOf(bot);
    const d = K.listDraft && K.listDraft.bot === bot ? K.listDraft : { bot, choice: saved === undefined ? "all" : saved.length ? "only" : "none", names: [...(saved || [])] };
    K.listDraft = d;
    const dis = isAdmin() ? "" : ' aria-disabled="true"';
    const radio = (value, label, line) =>
      `<li><button type="button" class="b-choice" role="radio" aria-checked="${d.choice === value}" data-k-choice="${value}"${dis}><span class="b-choice-text"><span class="b-choice-title">${label}</span><span class="b-choice-sub b-wrap">${line}</span></span>${icon("check", "icon b-tick")}</button></li>`;
    let html = sub(`${name}'s skills`, "main", "Back to settings");
    html += `<h4 class="b-group">Which skills ${name} is given</h4>`;
    html +=
      `<ul class="b-choices" role="radiogroup" aria-label="Which skills ${name} is given">` +
      radio("all", "Every skill", `${name} is given every skill the gateway finds usable: yours that are on, the ones shared on this gateway, and the gateway's own.`) +
      radio("only", "Only these", "The skills checked below.") +
      radio("none", "None", `${name} is given no skills from your library or the gateway's. Skills ${name} learned are still given.`) +
      `</ul>`;
    if (d.choice === "only") {
      const lib = G.skills.filter((s) => !s.removed && (mine(s) || s.shared || s.owner === null));
      const box = (value, label) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-k-name="${esc(value)}"${d.names.includes(value) ? " checked" : ""}${isAdmin() ? "" : " disabled"} /> ${label}</label></div>`;
      html += `<p class="k-subgroup">Your library</p><dl class="facts">${lib.map((s) => box(s.name, `<span class="k-box-text"><span>${esc(s.slug)}</span><small class="k-cmd mono">${esc(s.name)}</small></span>`)).join("")}</dl>`;
      html += `<p class="k-subgroup">On the gateway</p><dl class="facts">${GATEWAY_SKILLS.map((n) => box(n, `<span class="mono">${esc(n)}</span>`)).join("")}</dl>`;
      const unknown = d.names.filter((n) => !lib.some((s) => s.name === n) && !GATEWAY_SKILLS.includes(n));
      if (unknown.length)
        html +=
          `<p class="k-subgroup">Not on this gateway</p><dl class="facts">${unknown.map((n) => `<div class="b-row"><span class="b-row-main"><span class="mono">${esc(n)}</span></span>${isAdmin() ? button("Remove from the list", `data-k="list-drop" data-value="${esc(n)}" data-size="sm"`, "quiet") : ""}</div>`).join("")}</dl>` +
          `<p class="b-hint">A name that matches no skill gives ${name} nothing.</p>`;
    }
    html += `<p class="b-hint">Skills ${name} learned are given whatever this says. This decides what ${name} is given; it doesn't stop ${name}'s commands from reading files.</p>`;
    if (K.listNote) html += K.listNote;
    if (isAdmin()) {
      const changed = d.choice !== (saved === undefined ? "all" : saved.length ? "only" : "none") || (d.choice === "only" && JSON.stringify([...d.names].sort()) !== JSON.stringify([...(saved || [])].sort()));
      html += `<div class="b-actions" style="margin-top:12px">${button(K.listSaving ? "Saving…" : "Save", `data-k="list-save" data-size="sm"${changed && !K.listSaving && !(d.choice === "only" && !d.names.length) ? "" : " disabled"}`, "primary")}</div>`;
      if (d.choice === "only" && !d.names.length) html += `<p class="b-field-error">Check at least one skill, or choose None.</p>`;
    }
    html += learnedHtml(bot);
    return html;
  }

  const changeLine = (bot, name) => {
    const c = (G.changes[bot] || []).find((x) => x.skill === name);
    if (!c) return "When it was saved isn't in the gateway's recent changes.";
    if (c.actor === "agent") return c.task ? `Saved by ${botName(bot)} in ${c.task}, ${c.at}` : `Saved by ${botName(bot)}, ${c.at}`;
    return `${c.action === "archive" ? "Archived" : "Restored"} by a person, ${c.at}`;
  };

  function learnedHtml(bot) {
    const name = esc(botName(bot));
    const all = G.learned[bot] || [];
    const live = all.filter((l) => l.live);
    const archived = all.filter((l) => l.versions.length);
    let html = `<h4 class="b-group">What ${name} learned</h4><p class="b-hint" style="margin-top:0">Skills ${name} saved for itself on the gateway. They are given to ${name} in every task.</p>`;
    html += live.length
      ? `<ul class="k-rows">${live.map((l) => `<li><button type="button" class="k-row" data-k-learned="${esc(l.name)}" data-bs="learned"><span class="k-row-main"><span class="k-row-name mono">${esc(l.name)}</span><span class="k-row-when">${esc(l.description)}</span><small class="k-from">${esc(changeLine(bot, l.name))}</small></span>${icon("chevron")}</button></li>`).join("")}</ul>`
      : `<div class="work-empty"><span class="empty-mark">${icon("list")}</span><h4>Nothing learned yet</h4><p>When ${name} saves a skill for itself, it shows here.</p></div>`;
    if (archived.length)
      html += `<p class="k-subgroup">Archived</p><dl class="facts">${archived
        .map((l) => `<div class="b-row"><span class="b-row-main"><span class="mono">${esc(l.name)}</span><small>${l.versions.map((v) => `Archived ${esc(v.at)}`).join(" · ")}${l.live ? " · restored since" : ""}</small></span>${isAdmin() && !l.live ? button("Restore", `data-k="restore" data-value="${esc(l.name)}" data-size="sm"`) : ""}</div>`)
        .join("")}</dl>`;
    if (K.learnedNote) html += K.learnedNote;
    html += `<dl class="facts" style="margin-top:12px">${fact("Learning on its own", G.mode === "auto" ? "On" : "Off")}</dl><p class="b-hint">The gateway's setting. The gateway can save and update skills after long work, and archives ones unused for 30 days. Each change shows here.</p>`;
    return html;
  }

  function learnedView(bot) {
    const l = (G.learned[bot] || []).find((x) => x.name === K.learnedOpen) || (G.learned[bot] || [])[0];
    if (!l) return skillsView(bot);
    const changes = (G.changes[bot] || []).filter((c) => c.skill === l.name);
    let html = sub(esc(l.name), "skills", `Back to ${esc(botName(bot))}'s skills`);
    html += CONTENT;
    html += `<p class="k-label">Its text, as the gateway keeps it</p><pre class="k-plain">${esc(l.text)}</pre>`;
    html += `<dl class="facts">${fact("Files", l.files.map((f) => `<span class="mono">${esc(f)}</span>`).join(", "))}</dl>`;
    html += `<h4 class="b-group">Changes</h4><ul class="k-changes">${changes.map((c) => `<li>${esc(c.action === "create" ? changeLine(bot, l.name) : `${c.action === "archive" ? "Archived" : "Restored"} by a person, ${c.at}`)}</li>`).join("")}</ul>`;
    html += `<p class="b-hint">There is no editor for a learned skill: only ${esc(botName(bot))} changes it.</p>`;
    if (K.learnedNote) html += K.learnedNote;
    if (isAdmin() && l.live) html += `<div class="b-actions" style="margin-top:12px">${button("Archive…", 'data-k="archive" data-size="sm" data-tone="danger"', "quiet")}</div>`;
    return html;
  }

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { skills: skillsView, learned: learnedView });
  CT.botsPageNeeds = Object.assign(CT.botsPageNeeds || {}, {
    skills: (n) => `Changing which skills ${n} is given changes the gateway's settings. Archiving what ${n} learned needs admin access too.`,
    learned: (n) => `Archiving a skill ${n} learned needs admin access.`,
  });

  const rerenderTab = () => BS.render();

  function saveList(bot) {
    const d = K.listDraft;
    const mode = K.cfgMode;
    K.cfgMode = null;
    K.listSaving = true;
    K.listNote = null;
    rerenderTab();
    setTimeout(() => {
      K.listSaving = false;
      if (mode === "conflict") {
        // Another admin wrote the bot's settings since this page read them.
        G.lists[bot] = [];
        K.listDraft = null;
        K.listNote = note(`<p>Someone else changed ${esc(botName(bot))}'s settings. This shows what the gateway has now.</p>`, "warn");
        announce("Someone else changed these settings");
        return rerenderTab();
      }
      if (d.choice === "all") delete G.lists[bot];
      else G.lists[bot] = d.choice === "none" ? [] : [...d.names];
      K.listDraft = null;
      K.listNote = `<p class="b-hint" role="status">Saved. From each task's next turn, ${esc(botName(bot))} is given these. A turn running now keeps the skills it started with.</p>`;
      announce("Saved");
      rerenderTab();
      paintTask();
    }, 300);
  }

  // Wiring -------------------------------------------------------------------------------------------

  document.addEventListener("input", (event) => {
    const f = event.target.closest("[data-k-field]");
    if (f && K.draft) {
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
    }
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s" && settings()?.open && $('[data-k="save"]:not([disabled])', settings())) {
      event.preventDefault();
      save();
    }
  });

  // Leaving a page with unsaved text asks first (section 5).
  function leave(then) {
    if (!dirty() || !canWrite()) return then();
    D.confirmBox({
      title: "Leave without saving?",
      text: `Your edit to ${esc(K.page === "new" ? "this new skill" : gw(K.page)?.slug)} is lost.`,
      action: "danger",
      label: "Leave",
      run: then,
    });
  }

  document.addEventListener(
    "click",
    (event) => {
      // Closing Settings with unsaved text asks first.
      const close = event.target.closest('#settings-dialog [data-b="close"]');
      if (close && B.settings.section === "skills" && K.page && dirty() && canWrite()) {
        event.stopPropagation();
        event.preventDefault();
        return leave(() => {
          K.page = null;
          K.draft = null;
          settings().close();
        });
      }
      // The learned row remembers which skill opens before bot-settings.js navigates.
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
    if (choice && isAdmin() && K.listDraft) {
      K.listDraft.choice = choice.dataset.kChoice;
      return rerenderTab();
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
            const s = gw(K.page);
            K.compare = null;
            K.read = { rev: s.rev, description: s.description, body: s.body, saved: s.saved };
            K.draft = { slug: s.slug, description: s.description, body: s.body };
            K.status = statusNote(`<p>Showing the gateway's version, revision ${rev(s.rev)}.</p>`);
            rerender();
          },
        });
      case "save-as-new": {
        const s = gw(K.page);
        const d = K.draft;
        openPage("new");
        K.draft = { slug: "", description: d.description, body: d.body };
        K.status = note(`<p>${esc(s.slug)} was removed. Give your text a name to save it as a new skill.</p>`, "warn");
        rerender();
        return $("#k-slug", settings())?.focus();
      }
      case "enable": {
        const s = gw(K.page);
        K.busy = "enable";
        rerender();
        return setTimeout(() => {
          s.enabled = !s.enabled;
          K.busy = null;
          rerender();
          $('[data-k="enable"]', settings())?.focus();
          announce(s.enabled ? "New tasks start with it" : "New tasks don't start with it");
        }, 250);
      }
      case "share": {
        const s = gw(K.page);
        K.busy = "share";
        rerender();
        return setTimeout(() => {
          s.shared = !s.shared;
          K.busy = null;
          K.status = statusNote(s.shared ? `<p>Shared on this gateway. The gateway lists it with the team's skills.</p>` : `<p>No longer shared. Only you have it in your library.</p>`);
          rerender();
          $('[data-k="share"]', settings())?.focus();
          announce(s.shared ? "Shared on this gateway" : "No longer shared");
        }, 250);
      }
      case "remove": {
        const s = gw(K.page);
        return D.confirmBox({
          title: `Remove ${esc(s.slug)}?`,
          text: "It leaves your library and new tasks won't start with it. Tasks that have it keep their revision until it is detached there. You can't undo this; a new skill can take its name.",
          action: "danger",
          label: "Remove",
          run: () => {
            s.removed = true;
            K.page = null;
            K.draft = null;
            K.status = statusNote(`<p>Removed. ${esc(s.slug)} is no longer in your library.</p>`);
            rerender();
            $("#b-section-title", settings())?.focus();
            announce("Removed");
            paintTask();
          },
        });
      }
      // Skills in this task
      case "held-back":
        K.taskView = null;
        paintTask();
        return $(`[data-k-pin]`, $("#panel-details"))?.focus();
      case "pins-retry":
        K.pinState = "ready";
        return paintTask();
      case "refresh":
        return taskWrite("Updated to the latest revisions.", () => pins[taskId()].forEach((x) => gw(x.id) && (x.rev = gw(x.id).rev)));
      case "detach": {
        const x = pins[taskId()].find((y) => y.id === value);
        const go = () => taskWrite("Detached.", () => (pins[taskId()] = pins[taskId()].filter((y) => y.id !== value)));
        if (x.removed || gw(x.id)?.removed)
          return D.confirmBox({ title: `Detach ${esc(gw(x.id)?.slug || x.slug)}?`, text: "It was removed from your library, so it can't be attached again.", action: "danger", label: "Detach", run: go });
        return go();
      }
      case "attach-open":
        K.attachOpen = !K.attachOpen;
        paintTask();
        return $('[data-k="attach-open"]', $("#panel-details"))?.focus();
      case "attach":
        K.attachOpen = false;
        return taskWrite("Attached.", () => pins[taskId()].push(pinOf(value)));
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
            l.live = false;
            l.versions.push({ id: "20261119T150206000Z-archive", at: clock() });
            G.changes[bot].unshift({ skill: l.name, action: "archive", actor: "user", at: l.versions.at(-1).at });
            BS.S.view = "skills";
            K.learnedNote = `<p class="b-hint" role="status">Archived. ${esc(l.name)} is in Archived.</p>`;
            rerenderTab();
            announce("Archived");
          },
        });
      }
      case "restore": {
        const l = (G.learned[bot] || []).find((x) => x.name === value);
        return setTimeout(() => {
          l.live = true;
          const at = clock();
          G.changes[bot].unshift({ skill: l.name, action: "restore", actor: "user", at });
          K.learnedNote = `<p class="b-hint" role="status">Restored. ${esc(l.name)} is given to ${esc(botName(bot))} again.</p>`;
          rerenderTab();
          announce("Restored");
        }, 250);
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
        t.disabled = true;
        return setTimeout(() => {
          pins.jlearn.push(pinOf("trail"));
          line.innerHTML = `<span>Attached. This task has it from the next turn.</span>`;
          announce("Attached");
          paintTask();
        }, 250);
      }
    }
  });

  // Re-render this page's parts after bots.js changes the access tier.
  document.addEventListener("click", (event) => {
    if (event.target.closest('[data-b="request-write"], [data-b="request-check"]')) setTimeout(() => paintTask(), 0);
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

  window.skills = { G, K, pins, openPage };
  paintTask();
  if (p("section") === "skills" && p("open") === "settings") rerender();
})();
