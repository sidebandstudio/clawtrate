// Memory (docs/design/controls.md, sections 12 and 13): what a bot has stored,
// what loads into its new tasks and on what conditions, what search has
// confirmed, moving items, export and import, clearing, and shared memory with
// the bots that search it. Local fixtures only.

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const K = CT.ctl;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const { esc, icon, sub, openRow, fact, skeleton, failed, mark, markWords } = K;
  const { isAdmin, button, note, announce } = D;
  const BS = window.botSettings;
  const panel = $("#panel-settings");
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const current = () => app.model.selectedBot;
  const fmt = (n) => n.toLocaleString("en-US");

  const MEM = p("mem") || "";
  const FILE_BUDGET = 20000; // bootstrapMaxChars, as the gateway's settings give it
  const TOTAL_BUDGET = 60000; // bootstrapTotalMaxChars
  const USER_CAP = 4000; // the gateway's fixed limit for USER.md
  const X = {
    plugin: MEM !== "noplugin",
    item: p("item") || "m1",
    edit: MEM === "edit" || MEM === "conflict" ? p("item") || "m1" : null,
    add: MEM === "add" ? { text: "", where: "root" } : null,
    import: MEM === "import",
    conflict: MEM === "conflict",
    refused: null,
    sharedNote: null,
  };

  // Otto's memory files, as the workspace reader returns them, split into items.
  const searchable = MEM === "unsearchable" ? "Not confirmed for this revision" : "This revision found by search at 5:42 PM";
  const items = {
    otto: [
      { id: "m1", group: "root", text: "The media box is media-box; its disk is /srv, 2 TB.", file: "MEMORY.md", line: 3, rev: "7c1e", changed: "Nov 17, 5:41 PM", saver: "Otto, in 'Disk almost full on the media box', this revision" },
      { id: "m2", group: "root", text: "Weekly backups run Sunday at 3 AM; keep four weeks.", file: "MEMORY.md", line: 4, rev: "7c1e", changed: "Nov 17, 5:41 PM", saver: null },
      { id: "m3", group: "root", text: "Ask before deleting anything under /srv/archive.", file: "MEMORY.md", line: 5, rev: "7c1e", changed: "Nov 17, 5:41 PM", saver: "Added in Clawtrate from this device, this revision" },
      { id: "u1", group: "user", text: "Prefers short summaries with the numbers first.", file: "USER.md", line: 2, rev: "a210", changed: "Nov 10", saver: null },
      { id: "u2", group: "user", text: "Works in the evenings; send reports after 6 PM.", file: "USER.md", line: 3, rev: "a210", changed: "Nov 10", saver: null },
      { id: "n1", group: "notes", text: "Disk at 91% after the camera import. Moved old transcodes to /srv/archive.", file: "memory/2026-11-17.md", line: 1, rev: "19bd", changed: "Nov 17, 5:41 PM", saver: "Otto, in 'Disk almost full on the media box', this revision", size: "1.2 KB" },
      { id: "n2", group: "notes", text: "Router firmware is two releases behind; neither is urgent.", file: "memory/2026-11-16.md", line: 1, rev: "52aa", changed: "Nov 16, 9:02 AM", saver: null, size: "640 B" },
      { id: "n3", group: "notes", text: "Backup verify passed for all four weeks.", file: "memory/2026-11-12-backup.md", line: 1, rev: "0f3c", changed: "Nov 12", saver: null, size: "310 B" },
    ],
  };
  ["juniper", "marlow", "pip"].forEach((b) => (items[b] = [{ id: `${b}1`, group: "root", text: `${botName(b)} keeps its drafts in notes/.`, file: "MEMORY.md", line: 3, rev: "1d2e", changed: "Nov 15", saver: null }]));
  if (MEM === "empty") items.otto = [];
  if (MEM === "moving") items.otto.push({ ...items.otto[6], id: "n2b", group: "root", file: "MEMORY.md", line: 6, both: true }), (items.otto[6].both = true);
  const list = (bot) => items[bot] || [];
  const rootUsed = () => (MEM === "over" ? 21140 : 1240);
  const totalUsed = () => (MEM === "over" ? 30700 : 10800);
  const searchOff = MEM === "searchoff";

  // The Memory group in the bot's settings (bot-settings.js calls CT.botsExtraGroups).
  const extraBefore = CT.botsExtraGroups;
  CT.botsExtraGroups = (id) => {
    const l = list(id);
    const root = l.filter((i) => i.group === "root" && !i.both).length;
    const notes = l.filter((i) => i.group === "notes").length;
    const value = l.length ? `${root} root items · ${notes} notes · changed 5:41 PM` : "Nothing stored yet";
    return `<h3 class="b-tabgroup">Memory</h3><dl class="facts">${openRow("Memory", value, `data-bs="memory" aria-label="Memory: ${value}. Open."`)}</dl>` + (extraBefore ? extraBefore(id) : "");
  };

  function meter(used, cap, words, label) {
    const pct = Math.min(100, Math.round((used / cap) * 100));
    const tone = used > cap ? "danger" : pct >= 80 ? "warn" : "";
    return (
      `<div class="c-meter"${tone ? ` data-tone="${tone}"` : ""}><div class="c-meter-bar" role="meter" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${Math.min(used, cap)}" aria-label="${esc(label || words)}"><span style="width:${pct}%"></span></div>` +
      `<div class="c-meter-text"><span>${words}</span></div></div>`
    );
  }

  const loadsOf = (i) => (i.group === "notes" ? "Not loaded; found by search" : MEM === "over" && i.line > 4 ? "Past the budget: not loaded" : "Loads into new private tasks; fits its budget");
  const searchOf = (i) => (searchOff ? "Search is off for this bot" : i.group === "notes" ? (i.id === "n1" ? searchable : "This revision found by search at 5:42 PM") : "Not searched; loaded instead");
  const itemRow = (i) =>
    `<li><button type="button" class="c-mem" data-bs="memitem" data-c-item="${i.id}" aria-label="${esc(`${i.text} ${i.file}. Stored. ${loadsOf(i)}. Open.`)}">${icon(i.group === "root" ? "plan" : i.group === "user" ? "approval" : "note")}` +
    `<span class="c-mem-text"><span>${esc(i.text)}</span><small>${esc(i.file)}${i.size ? ` · ${i.size}` : ""} · Stored, revision ${i.rev} · ${loadsOf(i)}${i.group === "notes" && i.id === "n1" && MEM === "unsearchable" ? " · Not yet confirmed searchable" : ""}</small>` +
    (i.both ? `<small data-tone="danger">In root memory and in memory/2026-11-16.md: moving it didn't finish.</small>` : "") +
    `</span></button></li>`;

  function conditions(name) {
    return (
      `<p class="b-hint">Loaded at the start of ${name}'s new private tasks. Not in its routines, helpers, or group and channel tasks, and not text the gateway doesn't trust. ` +
      `MEMORY.md is cut past ${fmt(FILE_BUDGET)} characters, and all loaded files together past ${fmt(TOTAL_BUDGET)} (now ${fmt(totalUsed())}). ` +
      `If you keep your own USER.md on this gateway, ${name}'s tasks with you use yours instead of About you. A task already open may keep the earlier copy until it starts again.</p>`
    );
  }

  function memoryView(bot) {
    const name = esc(botName(bot));
    let html = sub(`What ${name} remembers`, "main", "Back to settings");
    if (MEM === "loading") return html + skeleton(`Loading ${name}'s memory`, 5);
    if (MEM === "error") return html + failed(`Couldn't load ${name}'s memory`, "mem-retry");
    html += `<p class="b-hint" style="margin-top:0">For each item: what is stored, whether it loads into new tasks, and whether search has found this revision.</p>`;
    if (!X.plugin) html += note(`<p>Changing notes needs Clawtrate's memory plugin running. The gateway's file writer takes only the files it loads.</p>`, "", icon("plug"));
    const l = list(bot);
    if (!l.length)
      return (
        html +
        `<div class="work-empty"><span class="empty-mark">${icon("memory")}</span><h4>Nothing stored yet</h4><p>${name} hasn't saved anything yet. When it does, it shows here.</p></div>` +
        (isAdmin() ? `<div class="b-actions" style="margin-top:12px">${button("Add to memory", 'data-c="mem-add" data-size="sm"')}</div>` : "")
      );
    const over = rootUsed() > FILE_BUDGET;
    const groups = [
      [
        "root",
        "Root memory",
        meter(rootUsed(), FILE_BUDGET, `MEMORY.md: ${fmt(rootUsed())} of ${fmt(FILE_BUDGET)} characters.${over ? ` ${fmt(rootUsed() - FILE_BUDGET)} characters at the end aren't loaded.` : ""}`, `Root memory ${fmt(rootUsed())} of ${fmt(FILE_BUDGET)} characters`) +
          meter(totalUsed(), TOTAL_BUDGET, `All loaded files: ${fmt(totalUsed())} of ${fmt(TOTAL_BUDGET)} characters.`, `All loaded files ${fmt(totalUsed())} of ${fmt(TOTAL_BUDGET)} characters`) +
          conditions(name),
      ],
      ["user", "About you", meter(420, USER_CAP, `420 of ${fmt(USER_CAP)} characters (the gateway's fixed limit for this file).`, "About you 420 of 4,000 characters")],
      [
        "notes",
        "Notes",
        `<p class="b-hint">Found when ${name} searches its memory. ${searchOff ? `Search is off for ${name} in the gateway's settings.` : MEM === "nosearch" ? `${name}'s memory search isn't set up on this gateway: Memory provider unavailable. Files are still listed.` : "Search: available. A revision counts as searchable only once a search returns it."}</p>`,
      ],
    ];
    groups.forEach(([g, title, foot]) => {
      const gi = l.filter((i) => i.group === g);
      if (gi.length) html += `<h4 class="b-group">${title}</h4><ul class="c-mems">${gi.map(itemRow).join("")}</ul>${foot}`;
    });
    if (X.add) html += addForm() + (X.refused || "");
    if (X.import) html += importReview();
    html +=
      `<div class="b-actions" style="margin-top:14px">` +
      (isAdmin() && !X.add ? button("Add to memory", 'data-c="mem-add" data-size="sm"') : "") +
      button("Export", 'data-c="mem-export" data-size="sm"') +
      (isAdmin() && X.plugin ? button("Import…", 'data-c="mem-import" data-size="sm"') : "") +
      `<span class="spacer"></span>` +
      (isAdmin() ? `<button type="button" class="link-button" data-c="mem-clear" style="color:var(--danger)">Clear memory…</button>` : "") +
      `</div>`;
    return html;
  }

  function addForm() {
    const a = X.add;
    return (
      `<div class="c-form" role="group" aria-label="Add to memory"><label>What to remember<textarea class="c-textarea" data-c-memtext>${esc(a.text)}</textarea></label>` +
      `<label>Where<select class="input" data-c-memwhere><option value="root"${a.where === "root" ? " selected" : ""}>Root memory (loads into new tasks)</option><option value="note"${a.where === "note" ? " selected" : ""}${X.plugin ? "" : " disabled"}>As a note (found by search)${X.plugin ? "" : ", needs Clawtrate's memory plugin"}</option></select></label>` +
      `<div class="b-actions">${button("Save", `data-c="mem-add-save" data-size="sm"${a.text.trim() ? "" : " disabled"}`, "primary")}${button("Cancel", 'data-c="mem-add-cancel" data-size="sm"', "quiet")}</div></div>`
    );
  }

  function importReview() {
    const found = ["Printer is on the second floor.", "Guest Wi-Fi changes on the first of the month.", "The NAS scrub runs on the first Sunday.", "The camera's reservation is 192.0.2.40.", "UPS holds about 40 minutes.", "Thermostat warms at 6:30 on weekdays."];
    return (
      `<div class="c-form" role="group" aria-label="Import"><p style="margin:0"><b>6 items from house-notes.md</b></p>` +
      found.map((f, i) => `<label class="b-check" style="flex-direction:row;color:var(--text)"><input type="checkbox" checked data-c-imp="${i}" /> ${esc(f)} <span class="b-faint">· As a note</span></label>`).join("") +
      `<p class="b-hint" style="margin:0">Nothing is saved until you choose Add.</p>` +
      `<div class="b-actions">${button("Add 6 items", 'data-c="mem-import-save" data-size="sm"', "primary")}${button("Cancel", 'data-c="mem-import-cancel" data-size="sm"', "quiet")}</div></div>`
    );
  }

  function itemView(bot) {
    const name = esc(botName(bot));
    const i = list(bot).find((x) => x.id === X.item) || list(bot)[0];
    let html = sub(i.group === "root" ? "Root memory" : i.group === "user" ? "About you" : "Note", "memory", `Back to what ${name} remembers`);
    const needsPlugin = i.group === "notes" && !X.plugin;
    if (X.edit === i.id) {
      html += `<label class="visually-hidden" for="c-memedit">Edit</label><textarea class="c-textarea" id="c-memedit" data-c-memedit>${esc(X.draft ?? i.text)}</textarea>`;
      if (X.conflict)
        html += note(
          `<p>${name}'s memory changed while you were editing. Your text is kept here; the file now has:</p><p class="mono">The media box is media-box; its disk is /srv, 4 TB since Nov 18.</p><div class="b-actions">${button("Save mine instead", 'data-c="mem-save-force" data-size="sm"')}</div>`,
          "warn",
        );
      html += `<div class="b-actions" style="margin-top:10px">${button("Save", 'data-c="mem-save" data-size="sm"', "primary")}${button("Cancel", 'data-c="mem-cancel" data-size="sm"', "quiet")}</div>`;
    } else html += `<div class="c-mem-full">${esc(i.text)}</div>`;
    if (i.both)
      html += note(`<p>In root memory and in memory/2026-11-16.md: moving it didn't finish.</p><div class="b-actions">${button("Finish moving", 'data-c="mem-finish" data-size="sm"', "primary")}${button("Keep both", 'data-c="mem-keepboth" data-size="sm"', "quiet")}</div>`, "danger");
    if (X.refused) html += X.refused;
    html +=
      `<dl class="facts">` +
      fact("File", `<span class="mono">${esc(i.file)}</span>, line ${i.line}`) +
      fact("Scope", `${name} only`) +
      fact("Stored", `Revision ${i.rev}, changed ${esc(i.changed)}`) +
      fact("Loads", i.group === "notes" ? "Not loaded; found by search" : `Into ${name}'s new private tasks, within the conditions on the memory page. A task already open may keep the earlier copy.`) +
      fact("Searchable", esc(searchOf(i))) +
      fact("Saved by", i.saver ? esc(i.saver) : "Who saved this revision isn't recorded.") +
      fact("Held by", i.group === "notes" ? markWords("memory") : "The gateway's file writer") +
      `</dl>`;
    if (isAdmin() && X.edit !== i.id) {
      html += `<div class="b-actions" style="margin-top:12px">`;
      if (!needsPlugin) html += button("Edit", 'data-c="mem-edit" data-size="sm"');
      if (i.group === "notes" && X.plugin) html += button("Move to root memory", 'data-c="mem-pin" data-size="sm"');
      if (i.group === "root" && X.plugin) html += button("Move to notes", 'data-c="mem-unpin" data-size="sm"');
      if (!needsPlugin) html += button("Delete…", 'data-c="mem-delete" data-size="sm"', "quiet");
      html += `</div>`;
      if (needsPlugin) html += `<p class="b-hint">Changing notes needs Clawtrate's memory plugin running.</p>`;
    }
    if (i.saver?.startsWith("Otto, in")) html += `<div class="b-actions" style="margin-top:8px">${button("Show in chat", 'data-c="show-in-chat" data-size="sm"', "quiet")}</div>`;
    return html;
  }

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { memory: memoryView, memitem: itemView });

  // Settings, Memory: shared memory and the bots that search it (section 13).
  const SHARED = p("shared") || "";
  const sharedItems =
    SHARED === "none"
      ? []
      : [
          { text: "The Wi-Fi printer is on the second floor.", file: "/srv/bots/shared/house.md" },
          { text: "Quiet hours are 22:00 to 07:00; don't send notifications then.", file: "/srv/bots/shared/house.md" },
        ];
  CT.botsSections.push(["memory", "Memory"]);
  CT.botsSectionViews.memory = ({ back }) => {
    const plugin = SHARED !== "noplugin" && X.plugin;
    let body = `<p class="b-lead" style="text-align:left;margin-top:0">Folders in the gateway's shared memory paths. Not loaded into any bot's prompt by themselves.</p>`;
    if (!sharedItems.length) {
      body += `<div class="work-empty"><span class="empty-mark">${icon("memory")}</span><h4>No shared memory</h4><p>Each bot has its own.</p></div>`;
      if (isAdmin()) body += `<div class="c-form"><label>A folder on the gateway's machine<input class="input mono" data-c-sharedpath placeholder="/srv/bots/shared" spellcheck="false" /></label><p class="b-hint" style="margin:0">The folder must already exist on the gateway's machine.</p><div class="b-actions">${button("Add a shared folder…", 'data-c="shared-add" data-size="sm"')}</div></div>`;
      return { title: "Memory", back, body, foot: isAdmin() ? "" : D.adminBar("Changing shared memory needs admin access.") };
    }
    body += `<p class="c-effective"><b>Searched by</b> Juniper, Marlow, Otto. <b>Not by</b> Pip: its memory search is off.</p>`;
    body += `<h4 class="b-group"><span class="mono">/srv/bots/shared</span></h4><ul class="c-mems">${sharedItems
      .map((s, i) => `<li><button type="button" class="c-mem" data-c="shared-item" data-value="${i}">${icon("note")}<span class="c-mem-text"><span>${esc(s.text)}</span><small>${esc(s.file)} · Stored · Searchable for Otto: not confirmed for this revision · Who saved it isn't recorded.</small></span></button></li>`)
      .join("")}</ul>`;
    if (!plugin) body += `<p class="b-hint">Changing shared memory needs Clawtrate's memory plugin running.</p>`;
    else if (isAdmin()) body += `<div class="b-actions" style="margin-top:12px">${button("Add", 'data-c="shared-new" data-size="sm"')}${button("Copy into every bot's root memory…", 'data-c="shared-pin" data-size="sm"')}</div>${X.sharedNote || ""}`;
    body += `<p class="b-hint">Each bot that searches this folder finds a change once its index has it. ${mark(plugin ? "memory" : "set")}</p>`;
    return { title: "Memory", back, body, foot: isAdmin() ? "" : D.adminBar("Changing shared memory needs admin access.") };
  };

  // Wiring ---------------------------------------------------------------------------------------

  const rerender = () => BS.render();
  document.addEventListener(
    "click",
    (event) => {
      const nav = event.target.closest("[data-bs]");
      if (nav && panel.contains(nav)) {
        if (nav.dataset.cItem) X.item = nav.dataset.cItem;
        if (nav.dataset.bs === "memory" && BS.S.view === "memitem") setTimeout(() => $(`[data-c-item="${X.item}"]`, panel)?.focus(), 40);
        if (nav.dataset.bs !== BS.S.view) X.refused = null;
      }
    },
    true,
  );

  const CLEAR_FILES = "MEMORY.md and memory/2026-11-17.md, memory/2026-11-16.md and memory/2026-11-12-backup.md";
  const NOT_REMOVED = "Otto's chat history; what tasks already running were given; search results until the index refreshes; copies of shared items in other bots; About you, unless you include it";

  document.addEventListener("click", (event) => {
    const t = event.target.closest("[data-c]");
    if (!t || t.disabled) return;
    const bot = current();
    const i = list(bot).find((x) => x.id === X.item);
    switch (t.dataset.c) {
      case "mem-retry":
        return rerender();
      case "mem-add":
        X.add = { text: "", where: "root" };
        rerender();
        return setTimeout(() => $("[data-c-memtext]", panel)?.focus(), 30);
      case "mem-add-cancel":
        X.add = null;
        return rerender();
      case "mem-add-save": {
        const text = X.add.text.trim();
        if (X.add.where === "root" && rootUsed() + text.length > FILE_BUDGET) {
          X.refused = note(`<p>Root memory would be ${fmt(rootUsed() + text.length)} of ${fmt(FILE_BUDGET)} characters, so the end wouldn't load. Move something out first.</p>`, "warn");
          return rerender();
        }
        list(bot).push({ id: `x${Date.now()}`, group: X.add.where === "root" ? "root" : "notes", text, file: X.add.where === "root" ? "MEMORY.md" : "memory/2026-11-18.md", line: 6, rev: "e4a9", changed: "just now", saver: "Added in Clawtrate from this device, this revision" });
        X.add = null;
        rerender();
        return announce("Memory saved");
      }
      case "mem-export":
        return announce(`Exported ${list(bot).length ? 7 : 0} files`);
      case "mem-import":
        X.import = true;
        return rerender();
      case "mem-import-cancel":
        X.import = false;
        return rerender();
      case "mem-import-save":
        X.import = false;
        rerender();
        return announce("Added 6 items");
      case "mem-clear":
        return D.confirmBox({
          title: `Clear ${botName(bot)}'s memory?`,
          text: X.plugin
            ? `This deletes ${CLEAR_FILES}. It doesn't remove: ${NOT_REMOVED.replace(/Otto/g, botName(bot))}. This can't be undone; export first to keep a copy.`
            : `This empties MEMORY.md. Notes under memory/ stay: deleting them needs Clawtrate's memory plugin. It doesn't remove: ${NOT_REMOVED.replace(/Otto/g, botName(bot))}.`,
          label: "Clear memory",
          run: () => {
            items[bot] = list(bot).filter((x) => x.group === "user" || (!X.plugin && x.group === "notes"));
            rerender();
            announce("Memory cleared");
          },
        });
      case "mem-edit":
        X.edit = X.item;
        X.draft = i.text;
        rerender();
        return setTimeout(() => $("[data-c-memedit]", panel)?.focus(), 30);
      case "mem-cancel":
        X.edit = null;
        X.conflict = false;
        return rerender();
      case "mem-save":
        if (X.conflict) return;
      // falls through
      case "mem-save-force":
        i.text = X.draft ?? i.text;
        i.rev = "e4a9";
        i.changed = "just now";
        i.saver = "Edited in Clawtrate from this device, this revision";
        X.edit = null;
        X.conflict = false;
        rerender();
        return announce("Memory saved");
      case "mem-pin":
        if (MEM === "over" || rootUsed() + i.text.length > FILE_BUDGET || MEM === "full") {
          X.refused = note(`<p>Root memory would be ${fmt(Math.max(rootUsed(), 19960) + 180)} of ${fmt(FILE_BUDGET)} characters, so the end wouldn't load. Move something out first. Both files are unchanged.</p>`, "warn");
          return rerender();
        }
        Object.assign(i, { group: "root", file: "MEMORY.md", line: 6, rev: "e4a9", changed: "just now" });
        rerender();
        return announce("Moved to root memory");
      case "mem-unpin":
        Object.assign(i, { group: "notes", file: "memory/2026-11-18.md", line: 1, rev: "e4b0", changed: "just now" });
        rerender();
        return announce("Moved to notes");
      case "mem-finish":
        items[bot] = list(bot).filter((x) => x.id !== "n2");
        list(bot).forEach((x) => delete x.both);
        rerender();
        return announce("Moved to root memory");
      case "mem-keepboth":
        list(bot).forEach((x) => delete x.both);
        rerender();
        return announce("Kept in both places");
      case "mem-delete":
        return D.confirmBox({
          title: "Delete this from memory?",
          text: `"${i.text}" It stops loading into ${botName(bot)}'s new tasks. It doesn't remove it from chat history or from what earlier tasks were given.`,
          label: "Delete",
          run: () => {
            items[bot] = list(bot).filter((x) => x.id !== i.id);
            BS.S.view = "memory";
            BS.render(true);
            announce("Deleted");
          },
        });
      case "shared-pin":
        return D.confirmBox({
          title: "Copy this into every bot's root memory?",
          text: "This puts the text into the root memory of Juniper, Marlow, Otto and Pip, so it loads into each one's new private tasks. Each copy is that bot's own; editing the shared file later doesn't change them. All or nothing.",
          label: "Copy",
          run: () => {
            X.sharedNote = `<p class="b-hint" role="status">Nothing was copied: Pip's root memory would pass its budget.</p>`;
            D.renderSettings();
          },
        });
      case "shared-add":
      case "shared-new":
      case "shared-item":
        return announce("Shared items open like a bot's, with the same facts and actions.");
    }
  });
  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t.matches("[data-c-memtext]") && X.add) {
      X.add.text = t.value;
      const save = $('[data-c="mem-add-save"]', panel);
      if (save) save.disabled = !t.value.trim();
    }
    if (t.matches("[data-c-memedit]")) X.draft = t.value;
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-c-memwhere]") && X.add) X.add.where = event.target.value;
  });

  window.controlsMemory = { X, items };
  BS.render();
})();
