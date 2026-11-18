// Memory (docs/design/controls.md, sections 12 and 13): what a bot remembers,
// one item, pinning, export and import, clearing, and the memory every bot can
// find. Local fixtures only.
//
// More address parameters:
//   bview=memory | memitem&item=<id>
//   mem=empty|loading|error|noplugin|nosearch|full|conflict|edit|add|import|clear|unsearchable
//   section=memory&shared=none|noplugin

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const K = CT.ctl;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const { esc, icon, sub, openRow, fact, skeleton, failed, mark, markWords } = K;
  const { isAdmin, adminBar, button, note, announce } = D;
  const BS = window.botSettings;
  const panel = $("#panel-settings");
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const current = () => app.model.selectedBot;

  const MEM = p("mem") || "";
  const BUDGET = 20000; // the gateway's per-file budget for MEMORY.md (bootstrapMaxChars)
  const USER_CAP = 4000;
  const X = {
    plugin: MEM !== "noplugin",
    item: p("item") || "m1",
    edit: MEM === "edit" ? p("item") || "m1" : null,
    add: MEM === "add" ? { text: "", where: "always" } : null,
    import: MEM === "import",
    conflict: MEM === "conflict",
    refused: null,
    searchable: MEM === "unsearchable" ? new Set() : null,
  };

  // Otto's memory files, as the workspace reader would return them, split into items.
  const items = {
    otto: [
      { id: "m1", group: "always", text: "The media box is media-box; its disk is /srv, 2 TB.", file: "MEMORY.md", line: 3, date: "Changed Nov 17", by: "Saved by Otto in 'Disk almost full on the media box', Nov 17, 5:41 PM" },
      { id: "m2", group: "always", text: "Weekly backups run Sunday at 3 AM; keep four weeks.", file: "MEMORY.md", line: 4, date: "Changed Nov 17", by: "Who saved it isn't recorded." },
      { id: "m3", group: "always", text: "Ask before deleting anything under /srv/archive.", file: "MEMORY.md", line: 5, date: "Changed Nov 12", by: "Added in Clawtrate from this device, Nov 12, 4:10 PM" },
      { id: "u1", group: "user", text: "Prefers short summaries with the numbers first.", file: "USER.md", line: 2, date: "Changed Nov 10", by: "Who saved it isn't recorded." },
      { id: "u2", group: "user", text: "Works in the evenings; send reports after 6 PM.", file: "USER.md", line: 3, date: "Changed Nov 10", by: "Who saved it isn't recorded." },
      { id: "n1", group: "notes", text: "Disk at 91% after the camera import. Moved old transcodes to /srv/archive.", file: "memory/2026-11-17.md", line: 1, date: "Nov 17", by: "Saved by Otto in 'Disk almost full on the media box', Nov 17, 5:41 PM", size: "1.2 KB" },
      { id: "n2", group: "notes", text: "Router firmware is two releases behind; neither is urgent.", file: "memory/2026-11-16.md", line: 1, date: "Nov 16", by: "Saved by Otto in 'Router firmware', Nov 16, 9:02 AM", size: "640 B" },
      { id: "n3", group: "notes", text: "Backup verify passed for all four weeks.", file: "memory/2026-11-12-backup.md", line: 1, date: "Nov 12", by: "Who saved it isn't recorded.", size: "310 B" },
    ],
  };
  ["juniper", "marlow", "pip"].forEach((b) => (items[b] = [{ id: `${b}1`, group: "always", text: `${botName(b)} keeps its drafts in notes/.`, file: "MEMORY.md", line: 3, date: "Changed Nov 15", by: "Who saved it isn't recorded." }]));
  if (MEM === "empty") items.otto = [];
  const list = (bot) => items[bot] || [];
  const used = (bot) => (MEM === "full" ? 19960 : 1240);
  const searchState = MEM === "nosearch" ? "none" : "ready";

  // The Memory group in the bot's settings (bot-settings.js calls CT.botsExtraGroups).
  const extraBefore = CT.botsExtraGroups;
  CT.botsExtraGroups = (id) => {
    const l = list(id);
    const always = l.filter((i) => i.group === "always").length;
    const notes = l.filter((i) => i.group === "notes").length;
    const value = l.length ? `${always} always loaded · ${notes} notes · updated 5:41 PM` : "Nothing saved yet";
    return (
      `<h3 class="b-tabgroup">Memory</h3><dl class="facts">${openRow("Memory", value, `data-bs="memory" aria-label="Memory: ${value}. Open."`)}</dl>` +
      (extraBefore ? extraBefore(id) : "")
    );
  };

  function meter(usedChars, cap, words) {
    const pct = Math.min(100, Math.round((usedChars / cap) * 100));
    const tone = pct >= 100 ? "danger" : pct >= 80 ? "warn" : "";
    const text = `${usedChars.toLocaleString("en-US")} of ${cap.toLocaleString("en-US")} characters.${words ? ` ${words}` : ""}`;
    return (
      `<div class="c-meter"${tone ? ` data-tone="${tone}"` : ""}><div class="c-meter-bar" role="meter" aria-valuemin="0" aria-valuemax="${cap}" aria-valuenow="${usedChars}" aria-label="${esc(text)}"><span style="width:${pct}%"></span></div>` +
      `<div class="c-meter-text"><span>${text}</span></div></div>`
    );
  }

  const itemRow = (i) =>
    `<li><button type="button" class="c-mem" data-bs="memitem" data-c-item="${i.id}" aria-label="${esc(`${i.text} ${i.file}, ${i.date}. Open.`)}">${icon(i.group === "always" ? "plan" : i.group === "user" ? "approval" : "note")}` +
    `<span class="c-mem-text"><span>${esc(i.text)}</span><small>${esc(i.file)}${i.size ? ` · ${i.size}` : ""} · ${esc(i.date)}${X.searchable && i.group === "notes" ? " · Not yet searchable" : ""}</small></span></button></li>`;

  function memoryView(bot) {
    const name = esc(botName(bot));
    let html = sub(`What ${name} remembers`, "main", "Back to settings");
    if (MEM === "loading") return html + skeleton(`Loading ${name}'s memory`, 5);
    if (MEM === "error") return html + failed(`Couldn't load ${name}'s memory`, "mem-retry");
    html += `<p class="b-hint" style="margin-top:0">${name}'s memory is files in its workspace. Always loaded: read at the start of each of ${name}'s private tasks. Notes: found when ${name} searches its memory.</p>`;
    if (!X.plugin) html += note(`<p>Changing notes needs Clawtrate's memory plugin. The gateway's file writer takes only the files it loads.</p>`, "", icon("plug"));
    const l = list(bot);
    if (!l.length)
      return (
        html +
        `<div class="work-empty"><span class="empty-mark">${icon("memory")}</span><h4>Nothing saved yet</h4><p>${name} hasn't saved anything yet. When it does, it shows here.</p></div>` +
        (isAdmin() ? `<div class="b-actions" style="margin-top:12px">${button("Add to memory", 'data-c="mem-add" data-size="sm"')}</div>` : "")
      );
    const groups = [
      ["always", "Always loaded", meter(used(bot), BUDGET, "Past that, the gateway cuts what it loads.") + `<p class="b-hint">Not loaded in ${name}'s routines, helpers, or group and channel tasks.</p>`],
      ["user", "About you", meter(420, USER_CAP, "")],
      [
        "notes",
        "Notes",
        `<p class="b-hint">${name} finds notes when it searches its memory. ${searchState === "none" ? `${name}'s memory search isn't set up on this gateway: Memory provider unavailable. Files are still listed.` : X.searchable ? "Search: behind. Some changes aren't searchable yet." : "Search: ready."}</p>`,
      ],
    ];
    groups.forEach(([g, title, foot]) => {
      const gi = l.filter((i) => i.group === g);
      if (!gi.length) return;
      html += `<h4 class="b-group">${title}</h4><ul class="c-mems">${gi.map(itemRow).join("")}</ul>${foot}`;
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
      `<label>Where<select class="input" data-c-memwhere><option value="always"${a.where === "always" ? " selected" : ""}>Always load</option><option value="note"${a.where === "note" ? " selected" : ""}${X.plugin ? "" : " disabled"}>As a note${X.plugin ? "" : " (needs Clawtrate's memory plugin)"}</option></select></label>` +
      `<div class="b-actions">${button("Save", `data-c="mem-add-save" data-size="sm"${a.text.trim() ? "" : " disabled"}`, "primary")}${button("Cancel", 'data-c="mem-add-cancel" data-size="sm"', "quiet")}</div></div>`
    );
  }

  function importReview() {
    const found = ["Printer is on the second floor.", "Guest Wi-Fi changes on the first of the month.", "The NAS scrub runs on the first Sunday.", "Camera reservation is 192.0.2.40.", "UPS holds about 40 minutes.", "Thermostat warms at 6:30 on weekdays."];
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
    let html = sub(i.group === "always" ? "Always loaded" : i.group === "user" ? "About you" : "Note", "memory", `Back to what ${name} remembers`);
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
    if (X.refused) html += X.refused;
    html +=
      `<dl class="facts">` +
      fact("File", `<span class="mono">${esc(i.file)}</span>, line ${i.line}`) +
      fact("Scope", `${name} only`) +
      fact("Date", esc(i.date)) +
      fact("Saved by", esc(i.by)) +
      fact("Takes effect", i.group === "notes" ? "When the gateway's memory index has the change. Clawtrate shows when it has it." : `From ${name}'s next private task, and in a task already open from its next message.`) +
      fact("Enforced by", i.group === "notes" ? markWords("memory") : "The gateway loads this file") +
      `</dl>`;
    if (isAdmin() && X.edit !== i.id) {
      html += `<div class="b-actions" style="margin-top:12px">`;
      if (!needsPlugin) html += button("Edit", 'data-c="mem-edit" data-size="sm"');
      if (i.group === "notes" && X.plugin) html += button("Always load", 'data-c="mem-pin" data-size="sm"');
      if (i.group === "always" && X.plugin) html += button("Stop always loading", 'data-c="mem-unpin" data-size="sm"');
      if (!needsPlugin) html += button("Delete…", 'data-c="mem-delete" data-size="sm"', "quiet");
      html += `</div>`;
      if (needsPlugin) html += `<p class="b-hint">Changing notes needs Clawtrate's memory plugin.</p>`;
    }
    if (i.by.startsWith("Saved by")) html += `<div class="b-actions" style="margin-top:8px">${button("Show in chat", 'data-c="show-in-chat" data-size="sm"', "quiet")}</div>`;
    return html;
  }

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { memory: memoryView, memitem: itemView });

  // Settings, Memory: what every bot can find (section 13).
  const SHARED = p("shared") || "";
  const sharedItems = SHARED === "none" ? [] : [
    { text: "The Wi-Fi printer is on the second floor.", file: "/srv/bots/shared/house.md" },
    { text: "Quiet hours are 22:00 to 07:00; don't send notifications then.", file: "/srv/bots/shared/house.md" },
  ];
  CT.botsSections.push(["memory", "Memory"]);
  CT.botsSectionViews.memory = ({ back }) => {
    const plugin = SHARED !== "noplugin" && X.plugin;
    let body = `<p class="b-lead" style="text-align:left;margin-top:0">Every bot searches these folders when it looks in its memory. They aren't loaded into a bot's prompt by themselves.</p>`;
    if (!sharedItems.length) {
      body += `<div class="work-empty"><span class="empty-mark">${icon("memory")}</span><h4>No shared memory</h4><p>Each bot has its own.</p></div>`;
      if (isAdmin())
        body +=
          `<div class="c-form"><label>A folder on the gateway's machine<input class="input mono" data-c-sharedpath placeholder="/srv/bots/shared" spellcheck="false" /></label><p class="b-hint" style="margin:0">The folder must already exist on the gateway's machine; Clawtrate can't create it.</p>` +
          `<div class="b-actions">${button("Add a shared folder…", 'data-c="shared-add" data-size="sm"')}</div></div>`;
      return { title: "Memory", back, body, foot: isAdmin() ? "" : adminBar("Changing shared memory needs admin access.") };
    }
    body += `<h4 class="b-group"><span class="mono">/srv/bots/shared</span></h4><ul class="c-mems">${sharedItems
      .map((s, i) => `<li><button type="button" class="c-mem" data-c="shared-item" data-value="${i}">${icon("note")}<span class="c-mem-text"><span>${esc(s.text)}</span><small>${esc(s.file)} · Every bot · Who saved it isn't recorded.</small></span></button></li>`)
      .join("")}</ul>`;
    if (!plugin) body += `<p class="b-hint">Changing shared memory needs Clawtrate's memory plugin.</p>`;
    else if (isAdmin())
      body += `<div class="b-actions" style="margin-top:12px">${button("Add", 'data-c="shared-new" data-size="sm"')}${button("Always load for every bot…", 'data-c="shared-pin" data-size="sm"')}</div>${X.sharedNote || ""}`;
    body += `<p class="b-hint">Changes reach every bot when the gateway's memory index has them. ${mark(plugin ? "memory" : "set")}</p>`;
    return { title: "Memory", back, body, foot: isAdmin() ? "" : adminBar("Changing shared memory needs admin access.") };
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

  document.addEventListener("click", (event) => {
    const t = event.target.closest("[data-c]");
    if (!t || t.disabled) return;
    const bot = current();
    const i = list(bot).find((x) => x.id === X.item);
    switch (t.dataset.c) {
      case "mem-retry":
        return rerender();
      case "mem-add":
        X.add = { text: "", where: "always" };
        rerender();
        return setTimeout(() => $("[data-c-memtext]", panel)?.focus(), 30);
      case "mem-add-cancel":
        X.add = null;
        return rerender();
      case "mem-add-save": {
        const text = X.add.text.trim();
        if (X.add.where === "always" && (MEM === "full" || used(bot) + text.length > BUDGET)) {
          X.refused = note(`<p>Pinned memory is full: ${esc(botName(bot))}'s always-loaded memory would pass ${BUDGET.toLocaleString("en-US")} characters. Unpin something first.</p>`, "warn");
          return rerender();
        }
        list(bot).push({ id: `x${Date.now()}`, group: X.add.where === "always" ? "always" : "notes", text, file: X.add.where === "always" ? "MEMORY.md" : "memory/2026-11-18.md", line: 6, date: "Changed just now", by: "Added in Clawtrate from this device, just now" });
        X.add = null;
        rerender();
        return announce("Memory saved");
      }
      case "mem-export":
        return announce(`Exported ${list(bot).length ? 6 : 0} files`);
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
            ? `This deletes MEMORY.md and every note under memory/. ${botName(bot)}'s files, tasks, routines, settings and shared memory stay. About you stays unless you include it. This can't be undone; export first to keep a copy.`
            : `This empties MEMORY.md. Notes under memory/ stay: clearing them needs Clawtrate's memory plugin. ${botName(bot)}'s files, tasks, routines, settings and shared memory stay.`,
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
        i.date = "Changed just now";
        X.edit = null;
        X.conflict = false;
        rerender();
        return announce("Memory saved");
      case "mem-pin":
        if (used(bot) + i.text.length > BUDGET || MEM === "full") {
          X.refused = note(`<p>Pinned memory is full: ${esc(botName(bot))}'s always-loaded memory would be ${(used(bot) + 180).toLocaleString("en-US")} of ${BUDGET.toLocaleString("en-US")} characters. Unpin something first.</p>`, "warn");
          return rerender();
        }
        Object.assign(i, { group: "always", file: "MEMORY.md", line: 6, date: "Changed just now" });
        rerender();
        return announce("Pinned");
      case "mem-unpin":
        Object.assign(i, { group: "notes", file: "memory/2026-11-18.md", line: 1, date: "Nov 18" });
        rerender();
        return announce("No longer always loaded");
      case "mem-delete":
        return D.confirmBox({
          title: "Delete this from memory?",
          text: `"${i.text}" ${botName(bot)} no longer receives it from its next private task.`,
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
          title: "Always load this for every bot?",
          text: "It is copied into the always-loaded memory of Juniper, Marlow, Otto and Pip, marked as shared.",
          label: "Always load",
          run: () => {
            X.sharedNote = `<p class="b-hint" role="status">Pinned memory is full for Pip. Nothing was copied.</p>`;
            D.renderSettings();
          },
        });
      case "shared-add":
      case "shared-new":
      case "shared-item":
        return announce("Shared memory items open like a bot's, with the same actions.");
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
