// The Work pane's contents, on local fixtures. docs/design/work-pane.md is the
// specification. This file extends app.js through CT.appExtension: it adds
// fixtures to the app's bots, fills the Files and Computer tabs, and adds the
// header's computer button. No gateway, no network.
//
// States from the address (see work-pane.md, section 22):
//   ?panel=open&tab=files                     the Files tab of Otto's disk task
//   ?files=loading|empty|error|stale|writing|commands|many
//   ?folder=/|notes|logs                       a workspace folder
//   ?file=notes/disk-2026-11-16.md             a file in the reader
//   ?fileview=preview|source|changes

(function () {
  const CT = window.CT;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  let app = null; // window.app, once app.js has started

  // Sizes in binary units, one decimal below 10.
  const size = (bytes) => {
    if (bytes === undefined) return "";
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB"];
    let n = bytes / 1024;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
      n /= 1024;
      i += 1;
    }
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  };
  // A long name shortens before its extension, which always stays in view: the
  // name part takes an ellipsis in the space the row measures, the extension never.
  const middle = (name) => {
    const dot = name.lastIndexOf(".");
    const base = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : "";
    return `<span class="fn-base">${esc(base)}</span><span class="fn-ext">${esc(ext)}</span>`;
  };
  const lines = (text) => text.replace(/\n$/, "").split("\n");

  // Fixtures: Otto's disk task -------------------------------------------------------------

  const NOW = "5:41 PM";
  const note1 =
    "# Disk on the media box, Nov 16\n\n" +
    "- Disk was 94% full at 5:31 PM.\n" +
    "- Largest: /var/lib/transcode-cache, about 180 GB.\n" +
    "- Then: container images, about 40 GB; rotated logs, about 6 GB.\n";
  const note2 =
    note1.replace("- Disk was 94% full at 5:31 PM.\n", "- Disk was 94% full at 5:31 PM; 61% after the move.\n") +
    "\n## Changed\n\n" +
    "- Moved the transcode cache to `transcode-cache.old`.\n" +
    "- To undo, move it back.\n";
  const note3 = note2 + "- Remove `transcode-cache.old` on Monday, Nov 23.\n";
  const inventory =
    "# Inventory\n\n" +
    "| Machine | Role | Disk |\n|---|---|---|\n" +
    "| media-box | media server, transcoding | 2 TB |\n" +
    "| rack-1 | backups | 8 TB |\n| rack-2 | containers | 1 TB |\n\n" +
    "Transcodes go to /var/lib/transcode-cache and are regenerated on demand.\n" +
    "Container images live under /var/lib/containers.\n";
  const agents =
    "# Otto\n\nYou are Otto, the operator for a small home server.\n\n" +
    "- Check before you change. Read logs and configs first.\n" +
    "- Report in this order: what you found, what you changed, what is left.\n";

  // One chart, drawn here, used as the image file and later as media.
  const chart = (w = 640, h = 360) =>
    `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Bar chart: disk use before and after, by folder">` +
    `<rect width="${w}" height="${h}" fill="#fbfbfa"/>` +
    `<text x="32" y="44" font-family="Figtree Variable, sans-serif" font-size="20" font-weight="600" fill="#111213">Disk use on media-box</text>` +
    `<text x="32" y="70" font-family="Figtree Variable, sans-serif" font-size="14" fill="#55575b">GB, before and after the move</text>` +
    [
      ["transcode-cache", 180, 0],
      ["containers", 40, 40],
      ["logs", 6, 6],
      ["media", 1660, 1660],
    ]
      .map(([label, before, after], i) => {
        const y = 104 + i * 58;
        const scale = (v) => Math.max(2, Math.round((Math.min(v, 200) / 200) * 380));
        return (
          `<text x="32" y="${y + 17}" font-family="Figtree Variable, sans-serif" font-size="14" fill="#111213">${label}</text>` +
          `<rect x="180" y="${y}" width="${scale(before)}" height="14" rx="4" fill="#5b8dff"/>` +
          `<rect x="180" y="${y + 18}" width="${scale(after)}" height="14" rx="4" fill="#45bdf5"/>` +
          `<text x="${Math.min(190 + scale(before), 560)}" y="${y + 12}" font-family="Figtree Variable, sans-serif" font-size="12" fill="#55575b">${before >= 200 ? `${before}, cut` : before}</text>`
        );
      })
      .join("") +
    `</svg>`;
  CT.chart = chart;

  const hunk = (title, rows) => ({ title, rows }); // rows: [kind, old, new, text]
  const files = {
    "notes/disk-2026-11-16.md": {
      folder: "notes",
      size: 412,
      time: "5:36 PM",
      full: "Today 5:36 PM",
      type: "text/markdown",
      kind: "text",
      md: true,
      group: "changed",
      content: note2,
      source: { step: "st-write2", words: "Edited by Otto at 5:36 PM" },
      changes: [
        {
          step: "st-write2",
          title: "Edited notes/disk-2026-11-16.md",
          time: "5:36 PM",
          add: 4,
          del: 1,
          hunks: [
            hunk("Lines 3–9", [
              ["ctx", 3, 3, ""],
              ["del", 4, null, "- Disk was 94% full at 5:31 PM."],
              ["add", null, 4, "- Disk was 94% full at 5:31 PM; 61% after the move."],
              ["ctx", 5, 5, "- Largest: /var/lib/transcode-cache, about 180 GB."],
              ["ctx", 6, 6, "- Then: container images, about 40 GB; rotated logs, about 6 GB."],
              ["add", null, 7, ""],
              ["add", null, 8, "## Changed"],
              ["add", null, 9, "- Moved the transcode cache to `transcode-cache.old`."],
            ]),
          ],
        },
        {
          step: "st-write1",
          title: "Wrote notes/disk-2026-11-16.md",
          time: "5:33 PM",
          add: 5,
          del: 0,
          created: true,
          hunks: [hunk("Lines 1–5", lines(note1).map((text, i) => ["add", null, i + 1, text]))],
        },
      ],
    },
    "charts/usage.png": {
      folder: "charts",
      size: 48230,
      time: "5:37 PM",
      full: "Today 5:37 PM",
      type: "image/png",
      kind: "image",
      group: "changed",
      source: null, // made by a command: nothing names the file
      byCommand: true,
    },
    "inventory.md": {
      folder: "",
      size: 1104,
      time: "Nov 12",
      full: "Thu, Nov 12 9:02 AM",
      type: "text/markdown",
      kind: "text",
      md: true,
      group: "read",
      content: inventory,
      source: { step: "st-read-inv", words: "Read by Otto at 5:31 PM" },
    },
    // A recording in the task's folder: sent by sessions.files.assets, up to 1 MB.
    "notes/voice-memo.m4a": {
      folder: "notes",
      size: 655360,
      time: "5:34 PM",
      full: "Today 5:34 PM",
      type: "audio/mp4",
      kind: "audio",
      duration: "0:48",
      group: "read",
      via: "sessions.files.assets",
      source: null,
    },
    // A video in the task's folder that is over the 1 MB the media method sends.
    "notes/cache-walkthrough.mp4": {
      folder: "notes",
      size: 14680064,
      time: "5:20 PM",
      full: "Today 5:20 PM",
      type: "video/mp4",
      kind: "video",
      group: "read",
      tooLarge: true,
      source: null,
    },
    "AGENTS.md": {
      folder: "",
      size: 214,
      time: "Nov 2",
      full: "Mon, Nov 2 4:10 PM",
      type: "text/markdown",
      kind: "text",
      md: true,
      group: "read",
      content: agents,
      source: { step: "st-read-agents", words: "Read by Otto at 5:31 PM" },
    },
    "logs/transcode.log": {
      folder: "logs",
      size: 3565158,
      time: "5:30 PM",
      full: "Today 5:30 PM",
      type: "text/plain",
      kind: "text",
      group: "read",
      tooLarge: true,
      source: { step: "st-read-log", words: "Read by Otto at 5:32 PM" },
    },
    // In the workspace only.
    "notes/receipts.pdf": { folder: "notes", size: 188416, time: "Oct 30", full: "Fri, Oct 30 11:48 AM", type: "application/pdf", kind: "binary", source: null },
    "notes/router-2026-11-02.md": { folder: "notes", size: 640, time: "Nov 2", full: "Mon, Nov 2 6:15 PM", type: "text/markdown", kind: "text", md: true, content: "# Router, Nov 2\n\n- Two releases behind. Neither is urgent.\n", source: null },
    "notes/ups-2026-11-06.md": { folder: "notes", size: 702, time: "Nov 6", full: "Fri, Nov 6 8:40 AM", type: "text/markdown", kind: "text", md: true, content: "# UPS, Nov 6\n\n- Holds 41 minutes at the current load.\n", source: null },
  };
  const folders = {
    "": { entries: ["charts", "logs", "notes", "reports", "AGENTS.md", "inventory.md"], times: { charts: "5:37 PM", logs: "5:30 PM", notes: "5:36 PM", reports: "Nov 9" } },
    notes: { entries: ["disk-2026-11-16.md", "receipts.pdf", "router-2026-11-02.md", "ups-2026-11-06.md"] },
    charts: { entries: ["usage.png"] },
    reports: { entries: [] },
    logs: { total: 1240 },
  };

  // Each task's pane: the Files stack, scroll per level, the sort, and what is being simulated.
  const pane = {};
  const paneFor = (t) =>
    (pane[t.id] ||= {
      stack: [],
      scroll: {},
      sort: "name",
      checked: "5:38 PM",
      list: t.id === "o1" ? params.get("files") || "loaded" : "loaded",
      writing: false,
      commands: t.id === "o1" && params.get("files") === "commands",
      logsLoaded: 250,
      filter: "",
    });

  const hasFiles = (t) => t?.id === "o1";

  // The conversation: Otto's disk task, in the conversation components ---------------------

  const turn = (role, html) => `<div class="turn" data-role="${role}" data-testid="transcript-turn">${html}</div>`;
  const bubble = (role, html, md = false) => `<div class="msg" data-role="${role}"><div class="bubble${md ? " md" : ""}">${html}</div></div>`;

  // The links a file step gains: "Open file", and "Back to <file>" after Show in chat.
  const fileLinks = (path, step) =>
    `<p class="step-file-links" data-file-links="${esc(path)}">` +
    CT.linkButton("Open file", { attrs: `data-open-file="${esc(path)}" data-from-step="${step}"`, name: `Open ${path.split("/").pop()} in the Work pane` }) +
    `</p>`;

  const raw = (tool, args, result, call, started, took) => ({
    tool,
    args: JSON.stringify(args, null, 2),
    result,
    running: result === undefined,
    timing: [
      ["Started", started],
      ["Took", took],
    ],
    ids: [
      ["Tool call", call],
      ["Run", "run_51c0e2"],
    ],
  });

  function readStep(id, path, detail, took) {
    const f = files[path];
    const body =
      CT.fields([["Path", path, { mono: true }]]) +
      fileLinks(path, id) +
      (f.content ? CT.codeBlock({ label: "Content", text: f.content }) : CT.note("Read the first 200 lines."));
    return CT.step({
      id,
      kind: "read",
      status: "done",
      title: `Read ${path}`,
      detail,
      statusText: took,
      body: CT.stepBody({ readable: body, raw: raw("read", { path }, f.content || "(200 lines)", `call_${id}`, "5:31:04 PM", took) }),
    });
  }

  function writeStep(id, path, verb, detail, time, status = "done", took = "0.2s") {
    const change = files[path].changes?.find((c) => c.step === id);
    const added = change ? change.hunks.flatMap((h) => h.rows.filter((r) => r[0] === "add").map((r) => r[3])).join("\n") : "";
    const body =
      CT.fields([["Path", path, { mono: true }]]) +
      fileLinks(path, id) +
      (status === "running" ? CT.note("Writing. The file updates when the write finishes.") : CT.codeBlock({ label: "Added", text: added || "(no lines)" }));
    return CT.step({
      id,
      kind: "write",
      status,
      title: status === "running" ? `Editing ${path}` : `${verb} ${path}`,
      detail,
      statusText: status === "running" ? "" : took,
      body: CT.stepBody({ readable: body, raw: raw("write", { path }, status === "running" ? undefined : "Wrote the file.", `call_${id}`, time, took) }),
    });
  }

  function commandStep(id, command, title, detail, took, output) {
    return CT.step({
      id,
      kind: "command",
      status: "done",
      title,
      detail,
      statusText: took,
      body: CT.stepBody({
        readable:
          CT.fields([
            ["Command", command, { mono: true }],
            ["Runs on", "media-box"],
          ]) + (output ? CT.codeBlock({ label: "Output", text: output }) : CT.note("The command printed nothing.")),
        raw: raw("exec", { command }, output || "(empty)", `call_${id}`, "5:31:20 PM", took),
      }),
    });
  }

  function diskTranscript(t) {
    const st = paneFor(t);
    const first =
      CT.stamp("Today 5:31 PM") +
      turn("user", bubble("user", "The media box says the disk is 94% full. What is eating the space?")) +
      turn(
        "assistant",
        CT.activity({
          id: "act-1",
          state: "completed",
          label: "Worked for 41s",
          count: "6 steps",
          steps:
            CT.step({
              id: "st-think",
              kind: "thought",
              status: "done",
              title: "Thought",
              detail: "Look at the inventory before guessing.",
              body: CT.stepBody({ readable: `<p class="reasoning">Look at the inventory before guessing. Then re-read my instructions so I report in the agreed order.</p>` }),
            }) +
            readStep("st-read-inv", "inventory.md", "11 lines", "0.1s") +
            readStep("st-read-agents", "AGENTS.md", "6 lines", "0.1s") +
            commandStep("st-du", "du -sh /var/lib/*", "Ran du", "exit 0", "6.2s", "180G\t/var/lib/transcode-cache\n40G\t/var/lib/containers\n6.1G\t/var/log") +
            readStep("st-read-log", "logs/transcode.log", "200 lines", "0.3s") +
            writeStep("st-write1", "notes/disk-2026-11-16.md", "Wrote", "+5 lines", "5:33:10 PM"),
          foot: CT.activityFoot({ model: "scripted/dev-1", effort: "medium", run: "run_51c0e2" }),
        }) +
          bubble(
            "assistant",
            `<h3>Found</h3><ol><li><code>/var/lib/transcode-cache</code>, about 180 GB of temporary transcodes.</li><li>Old container images, about 40 GB.</li><li>Rotated logs, about 6 GB.</li></ol>` +
              `<p>I wrote this down in <code>notes/disk-2026-11-16.md</code>. Should I move the transcode cache aside? Its files are regenerated on demand.</p>`,
            true,
          ),
      );
    const second =
      CT.stamp("Today 5:35 PM") +
      turn("user", bubble("user", "Yes, move it aside, and make me a chart of before and after.")) +
      turn(
        "assistant",
        CT.activity({
          id: "act-2",
          state: "completed",
          label: "Worked for 1m 04s",
          count: "3 steps",
          steps:
            commandStep("st-mv", "mv /var/lib/transcode-cache /var/lib/transcode-cache.old", "Ran mv", "exit 0", "0.4s", "") +
            commandStep("st-chart", "python3 tools/disk_chart.py --out charts/usage.png", "Ran python3", "exit 0", "2.1s", "chart written") +
            writeStep("st-write2", "notes/disk-2026-11-16.md", "Edited", "+4 −1 lines", "5:36:02 PM"),
          foot: CT.activityFoot({ model: "scripted/dev-1", effort: "medium", run: "run_77d413" }),
        }) +
          bubble("assistant", `<p>Done. The disk is now at 61%. I moved the cache to <code>transcode-cache.old</code> instead of deleting it, and updated the notes.</p>`, true) +
          (CT.work?.afterSecond?.(t) || ""),
      );
    const ask = CT.stamp("Today 5:41 PM") + turn("user", bubble("user", "Add the day you'll remove the old cache to the notes."));
    // While Otto writes (the "writing" fixture), a third run is under way.
    const third = st.writing
      ? ask +
        turn(
          "assistant",
          CT.activity({
            id: "act-3",
            state: "running",
            label: "Working",
            count: "1 step",
            open: true,
            steps: writeStep("st-write3", "notes/disk-2026-11-16.md", "Edited", "", "5:41:08 PM", "running"),
          }),
        )
      : st.wroteThird
        ? ask +
          turn(
            "assistant",
            CT.activity({
              id: "act-3",
              state: "completed",
              label: "Worked for 6s",
              count: "1 step",
              steps: writeStep("st-write3", "notes/disk-2026-11-16.md", "Edited", "+1 line", "5:41:08 PM"),
            }) + bubble("assistant", "<p>Added: I'll remove it on Monday, Nov 23.</p>", true),
          )
        : "";
    return first + second + third + (st.commandsRan ? commandsTurn() : "");
  }

  // "Otto runs a command" in the prototype bar: a command changes files without a file tool.
  const commandsTurn = () =>
    turn(
      "assistant",
      CT.activity({
        id: "act-4",
        state: "completed",
        label: "Worked for 3s",
        count: "1 step",
        steps: commandStep("st-gzip", "gzip logs/transcode.log.1", "Ran gzip", "exit 0", "2.8s", ""),
      }),
    );

  // Rendering the Files tab ---------------------------------------------------------------------

  const glyph = (state) => `<span class="glyph" data-state="${state}" aria-hidden="true"></span>`;

  function kindIcon(f) {
    if (!f) return "list";
    if (f.kind === "image") return "image";
    if (f.kind === "audio") return "audio";
    if (f.kind === "video") return "video";
    if (f.kind === "binary") return "page";
    return "file";
  }

  // The run marker: what a file tool's events established, and nothing else.
  function marker(path, st) {
    if (path !== "notes/disk-2026-11-16.md") return null;
    if (st.writing) return { words: "Writing…", writing: true };
    return { words: st.wroteThird ? "Changed this run" : "Changed last run" };
  }

  function fileRow(path, st, { inWorkspace = false } = {}) {
    const f = files[path];
    const name = path.split("/").pop();
    const m = marker(path, st);
    const folder = inWorkspace ? "" : f.folder;
    const sub = [folder, size(f.size), m ? (m.writing ? `<em>${m.words}</em>` : `<strong>${m.words}</strong>`) : ""].filter(Boolean).join(" · ");
    const spoken = m?.writing
      ? `${name}, Otto is writing it`
      : `${name}${folder ? `, in ${folder}` : ""}, ${size(f.size)}, changed ${f.time}${m ? `, ${m.words.toLowerCase()}` : ""}`;
    return (
      `<li><button type="button" class="file-row" data-open="${esc(path)}" data-key="f:${esc(path)}" title="${esc(name)}" aria-label="${esc(spoken)}">` +
      `<span class="file-icon">${m?.writing ? glyph("working") : icon(kindIcon(f))}</span>` +
      `<span class="file-name">${middle(name)}</span><time class="file-time">${f.time}</time>` +
      `<span class="file-sub">${sub}</span></button></li>`
    );
  }

  const folderRow = (path, name, time, count) =>
    `<li><button type="button" class="file-row" data-folder="${esc(path)}" data-key="d:${esc(path)}" aria-label="${esc(`${name}, folder${count ? `, ${count}` : ""}, changed ${time}`)}">` +
    `<span class="file-icon">${icon("list")}</span><span class="file-name">${esc(name)}</span><time class="file-time">${time}</time>` +
    `<span class="file-sub">Folder${count ? ` · ${count}` : ""}</span></button></li>`;

  function freshLine(st) {
    const lost = app && app.model.connection !== "connected";
    const words = lost ? `Last checked ${st.checked}` : st.checking ? "Checking…" : `Checked ${st.checked}`;
    return (
      `<div class="files-fresh"><span>${words}` +
      (st.commands && !lost ? `<span class="files-fresh-note">Otto ran commands since then. Files they changed show after a refresh.</span>` : "") +
      `</span>` +
      (lost
        ? ""
        : `<button type="button" class="icon-button" data-variant="quiet" data-files="refresh" data-key="refresh" aria-label="Refresh the file list" title="Refresh">` +
          `${st.checking ? glyph("working") : icon("retry")}</button>`) +
      `</div>`
    );
  }

  // Many files: the gateway's own search filters the task's list.
  const extraFiles = (st) =>
    st.list === "many"
      ? Array.from({ length: 35 }, (_, i) => {
          const day = String((i % 28) + 1).padStart(2, "0");
          const path = `logs/media-2026-10-${day}-${String(i + 1).padStart(2, "0")}.log`;
          files[path] ||= { folder: "logs", size: 20000 + i * 1311, time: `Oct ${(i % 28) + 1}`, full: `Oct ${(i % 28) + 1}`, kind: "text", group: "read", content: `log ${i + 1}\n`, source: null };
          return path;
        })
      : [];

  const emptyFiles = (b) =>
    `<div class="work-empty"><span class="empty-mark">${icon("file")}</span><h4>No files yet</h4><p>Files ${b.name} reads or writes in this task appear here.</p></div>`;

  function taskTop(b, t, st) {
    if (!hasFiles(t)) {
      const sent = CT.work?.sentInChat?.(b, t, st, "") || "";
      return `<div class="files">${sent ? freshLine(st) + sent : emptyFiles(b)}${workspaceRow(b)}</div>`;
    }
    if (st.list === "empty") return `<div class="files">${emptyFiles(b)}${workspaceRow(b)}</div>`;
    if (st.list === "loading") {
      return `<div class="files" aria-busy="true" aria-label="Loading this task's files"><div class="skeleton-row"></div><div class="skeleton-row"></div><div class="skeleton-row"></div></div>`;
    }
    if (st.list === "error") {
      return (
        `<div class="files"><div class="work-empty" role="alert"><span class="empty-mark">${glyph("failed")}</span>` +
        `<h4>Couldn't load this task's files</h4><p>The gateway didn't answer in time.</p>` +
        `<button type="button" class="button" data-size="sm" data-files="retry" data-key="retry">Try again</button></div>${workspaceRow(b)}</div>`
      );
    }
    const extra = new Set(extraFiles(st));
    const all = Object.keys(files).filter((p) => files[p].group && (!p.startsWith("logs/media-2026-10-") || extra.has(p)));
    const q = st.filter.trim().toLowerCase();
    const shown = q ? all.filter((p) => p.toLowerCase().includes(q)) : all;
    const group = (name, title) => {
      const rows = shown.filter((p) => files[p].group === name);
      return rows.length ? `<h3>${title}</h3><ul class="file-list">${rows.map((p) => fileRow(p, st)).join("")}</ul>` : "";
    };
    return (
      `<div class="files">` +
      freshLine(st) +
      (st.list === "stale"
        ? `<p class="files-alert" role="alert">Couldn't refresh. Showing the list from ${st.checked}.<button type="button" class="button" data-size="sm" data-files="retry" data-key="retry">Try again</button></p>`
        : "") +
      (all.length > 12
        ? `<div class="files-filter"><label class="visually-hidden" for="files-filter">Filter by name</label>` +
          `<input class="input" id="files-filter" type="search" placeholder="Filter by name" value="${esc(st.filter)}" autocomplete="off" />` +
          (q ? `<p role="status">${shown.length} of ${all.length} files</p>` : "") +
          `</div>`
        : "") +
      group("changed", "Changed") +
      group("read", "Read") +
      (CT.work?.sentInChat?.(b, t, st, q) || "") +
      (q && !shown.length ? `<p class="files-note">No files match “${esc(st.filter)}”.</p>` : "") +
      workspaceRow(b) +
      `</div>`
    );
  }

  const workspaceRow = (b) =>
    `<div class="files-workspace"><ul class="file-list"><li><button type="button" class="file-row" data-folder="" data-key="d:" aria-label="${b.name}'s workspace, all files, by folder">` +
    `<span class="file-icon">${icon("list")}</span><span class="file-name">${b.name}'s workspace</span>${icon("chevron", "icon chevron")}` +
    `<span class="file-sub">All files, by folder</span></button></li></ul></div>`;

  const head = (st, title, actions = "") => {
    const above = st.stack.length > 1 ? st.stack[st.stack.length - 2] : null;
    const back = above ? (above.kind === "folder" ? (above.path ? above.path.split("/").pop() : "the workspace") : "the file") : "this task's files";
    return (
      `<div class="files-head"><button type="button" class="icon-button" data-variant="quiet" data-files="back" aria-label="Back to ${esc(back)}" title="Back (⌘[)">${icon("back")}</button>` +
      `<h3 tabindex="-1" id="files-title">${esc(title)}</h3>${actions}</div>`
    );
  };

  function folderLevel(b, t, st, level) {
    const path = level.path;
    const title = path ? path.split("/").pop() : `${b.name}'s workspace`;
    const sortWords = st.sort === "name" ? "Name" : "Modified";
    const sortButton = `<button type="button" class="sort-button" data-files="sort" aria-haspopup="menu" aria-expanded="false" aria-label="Sort: ${sortWords}">${sortWords}${icon("chevron")}</button>`;
    if (!hasFiles(t)) {
      return `<div class="files">${head(st, title, sortButton)}<p class="files-path">1 item</p><ul class="file-list">${fileRowGeneric("AGENTS.md")}</ul></div>`;
    }
    if (path === "logs") {
      const total = folders.logs.total;
      const shown = Math.min(st.logsLoaded, total);
      const rows = Array.from({ length: shown }, (_, i) => {
        const n = String(i + 1).padStart(4, "0");
        const name = i === 0 ? "transcode.log" : `media-${n}.log`;
        const p = `logs/${name}`;
        files[p] ||= { folder: "logs", size: 4096 + ((i * 7919) % 90000), time: `Oct ${(i % 30) + 1}`, full: `Oct ${(i % 30) + 1}`, kind: "text", content: `entry ${n}\n`, source: null };
        return fileRow(p, st, { inWorkspace: true });
      }).join("");
      return (
        `<div class="files">${head(st, title, sortButton)}` +
        `<p class="files-path"><code>logs</code> · ${total.toLocaleString("en-US")} items</p>` +
        freshLine(st) +
        (shown < total ? `<p class="files-path">Sorted by ${st.sort === "name" ? "name" : "modified time"} among the ${shown.toLocaleString("en-US")} loaded.</p>` : "") +
        `<ul class="file-list">${rows}` +
        (shown < total
          ? `<li><button type="button" class="file-row" data-files="more" data-key="more:logs"><span class="file-icon">${icon("plus")}</span>` +
            `<span class="file-name">Show 250 more</span><span class="file-sub">${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")}</span></button></li>`
          : "") +
        `</ul></div>`
      );
    }
    const def = folders[path] || { entries: [] };
    const full = (e) => (path ? `${path}/${e}` : e);
    const subfolders = def.entries.filter((e) => folders[full(e)]);
    const filesHere = def.entries.filter((e) => !folders[full(e)]).map(full);
    if (st.sort === "modified") filesHere.sort((a, b2) => (files[b2].full.startsWith("Today") ? 1 : 0) - (files[a].full.startsWith("Today") ? 1 : 0));
    const rows =
      subfolders.map((e) => folderRow(full(e), e, def.times?.[e] || "Nov 9", e === "logs" ? "1,240 items" : "")).join("") +
      filesHere.map((p) => fileRow(p, st, { inWorkspace: true })).join("");
    return (
      `<div class="files">${head(st, title, sortButton)}` +
      `<p class="files-path">${path ? `<code>${esc(path)}</code> · ` : ""}${def.entries.length} ${def.entries.length === 1 ? "item" : "items"}</p>` +
      freshLine(st) +
      (def.entries.length ? `<ul class="file-list">${rows}</ul>` : `<p class="files-note">This folder is empty.</p>`) +
      `</div>`
    );
  }

  const fileRowGeneric = (name) =>
    `<li><button type="button" class="file-row" data-key="g:${name}" aria-label="${name}, 214 B"><span class="file-icon">${icon("file")}</span>` +
    `<span class="file-name">${name}</span><time class="file-time">Nov 2</time><span class="file-sub">214 B</span></button></li>`;

  // The reader ------------------------------------------------------------------------------------

  const codeView = (text, label) =>
    `<div class="code-view" tabindex="0" role="region" aria-label="${esc(label)}">` +
    lines(text)
      .map((line, i) => `<div class="code-line"><span class="ln" aria-hidden="true">${i + 1}</span><span class="lc">${esc(line) || " "}</span></div>`)
      .join("") +
    `</div>`;

  // A small markdown renderer for the fixtures: headings, lists, tables, code spans, paragraphs.
  function markdown(text) {
    const inline = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");
    const out = [];
    let list = null;
    let table = null;
    const flushTable = () => {
      if (!table) return;
      out.push(
        `<table><thead><tr>${table[0].map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead>` +
          `<tbody>${table.slice(1).map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`,
      );
      table = null;
    };
    for (const line of lines(text)) {
      if (/^\|/.test(line)) {
        const cells = line.split("|").slice(1, -1).map((c) => c.trim());
        if (cells.every((c) => /^-+$/.test(c))) continue;
        (table ||= []).push(cells);
        continue;
      }
      flushTable();
      if (/^- /.test(line)) {
        (list ||= []).push(`<li>${inline(line.slice(2))}</li>`);
        continue;
      }
      if (list) {
        out.push(`<ul>${list.join("")}</ul>`);
        list = null;
      }
      if (/^#{1,2} /.test(line)) out.push(`<h2>${inline(line.replace(/^#+ /, ""))}</h2>`);
      else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
    }
    flushTable();
    if (list) out.push(`<ul>${list.join("")}</ul>`);
    return `<div class="reader-preview md">${out.join("")}</div>`;
  }
  CT.markdown = markdown;

  // The checkout's comparison (?checkout=1): compared with where the branch left
  // main, which can include work from before this task. Never "since this task began".
  const checkoutDiff = () =>
    `<h3 class="change-group">In the checkout</h3>` +
    `<section class="change" role="region" aria-label="Compared with main, plus 9, minus 1"><p class="change-head"><strong>Compared with main</strong><span class="change-count">+9 −1</span></p>` +
    `<p class="change-note">In this checkout. This can include changes made before this task.</p>` +
    `<div class="diff" tabindex="0"><div class="diff-hunk">Lines 1–9</div>` +
    lines(note2)
      .slice(0, 9)
      .map((text, i) => `<div class="diff-line" data-kind="add"><span class="ln" aria-hidden="true"></span><span class="ln" aria-hidden="true">${i + 1}</span><span class="sign" aria-hidden="true">+</span><span class="visually-hidden">added: </span><span class="lc">${esc(text) || " "}</span></div>`)
      .join("") +
    `</div></section>`;

  function changesView(f) {
    return `<h3 class="change-group">This task's changes</h3>` + changesOfTask(f) + (params.get("checkout") === "1" ? checkoutDiff() : "");
  }

  function changesOfTask(f) {
    return f.changes
      .map((c) => {
        const headLine =
          `<p class="change-head"><strong>${esc(c.title)}</strong><span>${c.time}</span>` +
          `<span class="change-count">+${c.add} −${c.del}</span>` +
          CT.linkButton("Show in chat", { tone: "muted", attrs: `data-show-step="${c.step}"`, name: `Show “${c.title}” at ${c.time} in the chat` }) +
          `</p>`;
        const body = c.tooLarge
          ? CT.note(`This change is too large for the gateway to send. +${c.add} −${c.del}.`)
          : `<div class="diff" tabindex="0">` +
            (c.created ? `<div class="diff-hunk">Created in this task</div>` : "") +
            c.hunks
              .map(
                (h) =>
                  `<div class="diff-hunk">${h.title}</div>` +
                  h.rows
                    .map(
                      ([kind, a, n, text]) =>
                        `<div class="diff-line" data-kind="${kind}"><span class="ln" aria-hidden="true">${a ?? ""}</span><span class="ln" aria-hidden="true">${n ?? ""}</span>` +
                        `<span class="sign" aria-hidden="true">${kind === "add" ? "+" : kind === "del" ? "−" : ""}</span>` +
                        `<span class="visually-hidden">${kind === "add" ? "added: " : kind === "del" ? "removed: " : ""}</span><span class="lc">${esc(text) || " "}</span></div>`,
                    )
                    .join(""),
              )
              .join("") +
            `</div>`;
        return `<section class="change" role="region" aria-label="${esc(`${c.title}, ${c.time}, plus ${c.add}, minus ${c.del}`)}" data-change="${c.step}">${headLine}${body}</section>`;
      })
      .join("");
  }

  const facts = (f, name, why) =>
    `<dl class="facts reader-facts">` +
    `<div><dt>Name</dt><dd><span>${esc(name)}</span>${CT.copyButton("name", name)}</dd></div>` +
    (f.size !== undefined ? `<div><dt>Size</dt><dd>${size(f.size)}</dd></div>` : "") +
    (f.full ? `<div><dt>Modified</dt><dd>${f.full}</dd></div>` : "") +
    (f.type ? `<div><dt>Type</dt><dd>${f.type}</dd></div>` : "") +
    (f.folder !== undefined ? `<div><dt>Folder</dt><dd><span>${esc(f.folder || "The workspace's top")}</span>${f.folder ? CT.copyButton("folder", f.folder) : ""}</dd></div>` : "") +
    `</dl><p class="reader-why">${why}</p>`;
  CT.workFacts = facts;

  function readerLevel(b, t, st, level) {
    const path = level.path;
    const f = files[path];
    const name = path.split("/").pop();
    // Which read method sends it (work-pane.md, section 8); nothing sends the rest.
    const sendable = ["text", "image", "audio", "video"].includes(f.kind) && !f.tooLarge;
    const actions =
      (sendable
        ? `<button type="button" class="icon-button" data-variant="quiet" data-files="download" aria-label="Download ${esc(name)}" title="Download">${icon("download")}</button>`
        : "") +
      (sendable && f.kind === "text"
        ? `<button type="button" class="icon-button" data-variant="quiet" data-files="copy" aria-label="Copy the text of ${esc(name)}" title="Copy">${icon("copy")}</button>`
        : "");
    const meta = [f.folder, size(f.size), f.full].filter(Boolean).join(" · ");
    const source = f.source
      ? `<p class="reader-source"><span>${f.source.words}</span>${CT.linkButton("Show in chat", { attrs: `data-show-step="${f.source.step}"`, name: `Show the step that last touched ${name} in the chat` })}</p>`
      : f.byCommand
        ? `<p class="reader-source" data-none="true">No source in this task. A command made it, and commands don't name the files they change.</p>`
        : `<p class="reader-source" data-none="true">No source in this task</p>`;

    const views = [];
    if (f.kind === "text" && !f.tooLarge) {
      if (f.md) views.push(["preview", "Preview"]);
      views.push(["source", "Source"]);
      if (f.changes) views.push(["changes", "Changes"]);
    }
    const view = level.view && views.some(([k]) => k === level.view) ? level.view : views[0]?.[0];
    level.view = view;
    const seg =
      views.length > 1
        ? `<div class="seg reader-views" role="tablist" aria-label="View">` +
          views.map(([k, label]) => `<button type="button" role="tab" id="fileview-${k}" aria-selected="${k === view}" tabindex="${k === view ? 0 : -1}" data-fileview="${k}">${label}</button>`).join("") +
          `</div>`
        : "";

    const isNotes = path === "notes/disk-2026-11-16.md";
    const banner =
      st.writing && isNotes
        ? `<p class="reader-banner" role="status">${glyph("working")}Otto is writing this file. It updates when the write finishes.</p>`
        : st.updated && isNotes
          ? `<p class="reader-banner" role="status">Updated just now</p>`
          : "";

    let body;
    if (f.tooLarge && f.kind === "text") body = facts(f, name, `${esc(name)} is ${size(f.size)}. The gateway sends text up to 256 KB, so it can't be shown or downloaded here.`);
    else if (f.tooLarge) body = facts(f, name, `${esc(name)} is ${size(f.size)}. The gateway sends recordings and videos from a task's folder up to 1 MB, so it can't be played or downloaded here.`);
    else if (f.kind === "binary") body = facts(f, name, `${esc(name)} isn't text or media. None of the gateway's file methods sends files like this, so it can't be shown or downloaded here.`);
    else if (f.kind === "audio")
      body =
        `<div class="audio-player"><div class="artifact" data-kind="audio"><button type="button" class="artifact-play" data-play-file="${esc(path)}" aria-pressed="false" aria-label="Play ${esc(name)}, ${f.duration}">` +
        `<span class="artifact-tile" data-round="true">${icon("play")}</span></button><span class="artifact-text"><span class="artifact-name">${esc(name)}</span>` +
        `<span class="artifact-sub" id="file-audio-sub">Audio · ${size(f.size)} · ${f.duration}</span></span></div></div>`;
    else if (f.kind === "image") body = `<button type="button" class="reader-image" data-files="viewer" aria-label="Open ${esc(name)} full size">${chart()}</button>`;
    else if (view === "preview") body = markdown(f.content);
    else if (view === "changes") body = changesView(f);
    else body = codeView(f.content, `${name}, ${lines(f.content).length} lines`);

    return (
      `<div class="files reader">${head(st, name, actions)}` +
      `<p class="reader-meta">${meta}</p>${source}${banner}${seg}` +
      `<div class="reader-body" id="reader-body"${views.length > 1 ? ` role="tabpanel" aria-labelledby="fileview-${view}"` : ""}>${body}</div>` +
      `</div>`
    );
  }

  function renderFiles(b, t) {
    const el = $("#panel-files");
    if (!el) return;
    if (!t) {
      el.innerHTML = `<p class="work-note">Pick one of ${b.name}'s tasks to see its files.</p>`;
      return;
    }
    const st = paneFor(t);
    const level = st.stack[st.stack.length - 1];
    el.innerHTML = !level
      ? taskTop(b, t, st)
      : level.kind === "folder"
        ? folderLevel(b, t, st, level)
        : level.kind === "artifact"
          ? CT.work.artifactLevel(b, t, st, level, head)
          : readerLevel(b, t, st, level);
    CT.hydrate(el);
    const scroller = $(".work-sections");
    if (scroller && !$("#panel-files").hidden) scroller.scrollTop = st.scroll[key(st)] || 0;
  }
  const key = (st) => st.stack.map((l) => `${l.kind}:${l.path}`).join("/") || "top";

  // Navigation inside Files ----------------------------------------------------------------------

  const currentBot = () => app.bots.find((b) => b.id === app.model.selectedBot);
  const current = () => currentBot()?.tasks.find((x) => x.id === app.model.selectedTask) || null;

  function rerender(focus) {
    renderFiles(currentBot(), current());
    if (focus === "title") $("#files-title")?.focus();
    else if (focus) $(`[data-key="${CSS.escape(focus)}"]`, $("#panel-files"))?.focus();
  }

  function push(level) {
    const st = paneFor(current());
    st.scroll[key(st)] = $(".work-sections").scrollTop;
    st.stack.push(level);
    rerender("title");
  }

  function back() {
    const st = paneFor(current());
    if (!st.stack.length) return false;
    const left = st.stack.pop();
    st.updated = false;
    rerender(left.kind === "folder" ? `d:${left.path}` : left.kind === "artifact" ? `a:${left.path}` : `f:${left.path}`);
    return true;
  }

  // Open a file from anywhere: a step, a card, the address.
  function openLevel(level) {
    const st = paneFor(current());
    st.stack = [level];
    app.setPanel(true);
    app.setTab("files");
    rerender("title");
  }
  function openFile(path, { view, from } = {}) {
    openLevel({ kind: "file", path, view, from });
    if (view === "changes" && from) $(`[data-change="${from}"]`)?.scrollIntoView({ block: "start" });
  }

  // Show in chat: the step, opened and briefly filled; or the message.
  function reveal(node, focusTarget) {
    if (app.overlaying()) app.setPanel(false); // a drawer or sheet steps aside so the step is visible
    const transcript = $("#transcript");
    const top = transcript.getBoundingClientRect().top + 98 + 8; // under the protected band
    transcript.scrollTop += node.getBoundingClientRect().top - top;
    node.dataset.flash = "false";
    void node.offsetWidth;
    node.dataset.flash = "true";
    setTimeout(() => (node.dataset.flash = "false"), 1700);
    focusTarget.focus({ preventScroll: true });
  }

  function showInChat(stepId, path) {
    const step = document.getElementById(stepId);
    if (!step) return;
    const block = step.closest("details.activity");
    if (block) block.open = true;
    step.open = true;
    reveal(step, $(":scope > summary", step));
    CT.announce("Showing the step in the chat");
    // Coming back: "Back to <file>" on the step while the pane is not showing that file.
    const links = $("[data-file-links]", step);
    if (links && path && !$("[data-back-to-file]", links)) {
      links.insertAdjacentHTML(
        "beforeend",
        CT.linkButton(`Back to ${path.split("/").pop()}`, { tone: "muted", attrs: `data-back-to-file="${esc(path)}"`, name: `Back to ${path.split("/").pop()} in the Work pane` }),
      );
    }
  }

  function download(path) {
    const f = files[path];
    const name = path.split("/").pop();
    const data = f.kind === "audio" || f.kind === "video" ? new Blob([new TextEncoder().encode(`${name}: sample bytes\n`)], { type: f.type }) : f.kind === "image" ? new Blob([chart().replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ')], { type: "image/svg+xml" }) : new Blob([new TextEncoder().encode(f.content)], { type: f.type || "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(data);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    CT.announce(`Downloaded ${name}`);
  }

  async function copyText(text, name, button, selectIn) {
    try {
      await navigator.clipboard.writeText(text);
      button.innerHTML = icon("check");
      CT.announce(`Copied ${name}`);
    } catch {
      button.innerHTML = icon("warning");
      const view = selectIn && $(selectIn, $("#panel-files"));
      if (view) getSelection().selectAllChildren(view);
      CT.announce("Couldn't copy. The text is selected.");
    }
    setTimeout(() => (button.innerHTML = icon("copy")), 1400);
  }

  // Simulated gateway events ---------------------------------------------------------------------

  function refetch(st) {
    st.checking = true;
    rerender("refresh");
    setTimeout(() => {
      st.checking = false;
      st.checked = NOW;
      st.commands = false;
      if (st.list === "stale" || st.list === "error") st.list = "loaded";
      const s = $(".work-sections").scrollTop;
      rerender("refresh");
      $(".work-sections").scrollTop = s;
    }, 700);
  }

  // A file tool's result arrives: the step finishes, the file and its list are fetched again.
  function finishWrite() {
    const t = current();
    const st = paneFor(t);
    if (!st.writing) return;
    const f = files["notes/disk-2026-11-16.md"];
    st.writing = false;
    st.wroteThird = true;
    f.content = note3;
    f.size = 469;
    f.time = NOW;
    f.full = `Today ${NOW}`;
    f.source = { step: "st-write3", words: `Edited by Otto at ${NOW}` };
    f.changes.unshift({
      step: "st-write3",
      title: "Edited notes/disk-2026-11-16.md",
      time: NOW,
      add: 1,
      del: 0,
      hunks: [
        hunk("Line 11", [
          ["ctx", 10, 10, "- To undo, move it back."],
          ["add", null, 11, "- Remove `transcode-cache.old` on Monday, Nov 23."],
        ]),
      ],
    });
    const transcript = $("#transcript");
    const top = transcript.scrollTop;
    const body = $(".work-sections");
    const scroll = body.scrollTop;
    t.html = diskTranscript(t);
    t.status = "idle";
    t.when = NOW;
    const reading = st.stack.at(-1)?.path === "notes/disk-2026-11-16.md";
    st.updated = reading;
    st.checked = NOW;
    app.openTask(app.model.selectedBot, t.id); // re-renders the conversation and the pane
    transcript.scrollTop = top;
    body.scrollTop = scroll; // the place is kept
    if (reading) CT.announce("disk-2026-11-16.md updated");
    setTimeout(() => {
      st.updated = false;
      if (current() === t) {
        const s = $(".work-sections").scrollTop;
        rerender();
        $(".work-sections").scrollTop = s;
      }
    }, 4000);
  }

  function startWrite() {
    const t = current();
    const st = paneFor(t);
    if (st.writing || st.wroteThird) return;
    st.writing = true;
    t.status = "running";
    t.when = "now";
    t.html = diskTranscript(t);
    const body = $(".work-sections");
    const scroll = body.scrollTop;
    app.openTask(app.model.selectedBot, t.id);
    body.scrollTop = scroll;
    $("#transcript").scrollTop = $("#transcript").scrollHeight;
  }

  function runCommand() {
    const t = current();
    const st = paneFor(t);
    st.commands = true;
    st.commandsRan = true;
    t.html = diskTranscript(t);
    const body = $(".work-sections");
    const scroll = body.scrollTop;
    app.openTask(app.model.selectedBot, t.id);
    body.scrollTop = scroll;
    $("#transcript").scrollTop = $("#transcript").scrollHeight;
  }

  // The extension -----------------------------------------------------------------------------------

  CT.appExtension = {
    fixtures(bots) {
      const otto = bots.find((b) => b.id === "otto");
      const disk = otto.tasks.find((t) => t.id === "o1");
      const st = paneFor(disk);
      if (params.get("files") === "writing") {
        st.writing = true;
        disk.status = "running";
        disk.when = "now";
      }
      disk.html = diskTranscript(disk);
      CT.work.extendFixtures?.(bots);
      // The address can open a folder or a file.
      const folder = params.get("folder");
      const file = params.get("file");
      if (folder !== null) st.stack.push({ kind: "folder", path: folder === "/" ? "" : folder });
      if (file && files[file]) st.stack.push({ kind: "file", path: file, view: params.get("fileview") || undefined });
    },
    panel(b, t) {
      renderFiles(b, t);
      if (CT.work.renderComputer) CT.work.renderComputer(b, t);
      else {
        const comp = $("#panel-computer");
        comp.innerHTML =
          `<div class="work-empty"><span class="empty-mark">${icon("screen")}</span><h4>No screen to show</h4>` +
          `<p>When ${b.name} uses a browser or a desktop, you can watch it here.</p></div>`;
      }
    },
    header(b, t) {
      CT.work.header?.(b, t);
    },
    tabChanged(name) {
      CT.work.tabChanged?.(name);
      fitTabs();
    },
    connectionChanged(name) {
      if (!app) return;
      const b = currentBot();
      if (b) this.panel(b, current());
      CT.work.connectionChanged?.(name);
    },
    panelChanged(open) {
      CT.work.panelChanged?.(open);
    },
    ready(a) {
      app = a;
      CT.work.ready?.(a);
      const b = currentBot();
      if (b) this.panel(b, current()); // the connection's first state is known now
    },
  };

  // The tab bar when its tabs do not fit (bots.md, section 19): narrower padding
  // first, then a sideways scroll with the chosen tab in view and a fade at each
  // clipped edge.
  function fitTabs() {
    const bar = $(".tabs");
    if (!bar) return;
    delete bar.dataset.fit;
    if (bar.scrollWidth > bar.clientWidth) bar.dataset.fit = "narrow";
    if (bar.scrollWidth > bar.clientWidth) bar.dataset.fit = "scroll";
    const chosen = $('.tab[aria-selected="true"]', bar);
    if (bar.dataset.fit === "scroll" && chosen) {
      const left = chosen.offsetLeft - bar.offsetLeft;
      if (left < bar.scrollLeft + 16) bar.scrollLeft = left - 16;
      else if (left + chosen.offsetWidth > bar.scrollLeft + bar.clientWidth - 16) bar.scrollLeft = left + chosen.offsetWidth - bar.clientWidth + 16;
    }
    clip(bar);
  }
  function clip(bar) {
    const start = bar.scrollLeft > 1;
    const end = bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 1;
    if (start && end) bar.dataset.clip = "both";
    else if (start) bar.dataset.clip = "start";
    else if (end) bar.dataset.clip = "end";
    else delete bar.dataset.clip;
  }
  document.addEventListener("DOMContentLoaded", () => {
    const bar = $(".tabs");
    if (!bar) return;
    new ResizeObserver(() => fitTabs()).observe(bar);
    bar.addEventListener("scroll", () => clip(bar));
  });
  CT.fitTabs = fitTabs;

  // Wiring ------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const target = event.target;

    // A recording from the task's folder plays in the pane.
    const playFile = target.closest("[data-play-file]");
    if (playFile) {
      const on = playFile.getAttribute("aria-pressed") !== "true";
      const f = files[playFile.dataset.playFile];
      playFile.setAttribute("aria-pressed", String(on));
      playFile.setAttribute("aria-label", `${on ? "Pause" : "Play"} ${playFile.dataset.playFile.split("/").pop()}, ${f.duration}`);
      $(".artifact-tile", playFile).innerHTML = icon(on ? "pause" : "play");
      $("#file-audio-sub").innerHTML = on ? `<span class="audio-track"><span style="width:12%"></span></span>0:06 / ${f.duration}` : `Audio · ${size(f.size)} · ${f.duration}`;
      return;
    }
    const openFromStep = target.closest("[data-open-file]");
    if (openFromStep) {
      const step = openFromStep.closest("details.step");
      return openFile(openFromStep.dataset.openFile, { view: step?.dataset.kind === "write" ? "changes" : "source", from: openFromStep.dataset.fromStep });
    }
    const backTo = target.closest("[data-back-to-file]");
    if (backTo) {
      const path = backTo.dataset.backToFile;
      backTo.remove();
      const st = paneFor(current());
      if (!st.stack.length || st.stack.at(-1).path !== path) st.stack = [{ kind: "file", path }];
      app.setPanel(true);
      app.setTab("files");
      return rerender("title");
    }
    const show = target.closest("[data-show-step]");
    if (show) return showInChat(show.dataset.showStep, paneFor(current()).stack.at(-1)?.path);

    if (!target.closest("#panel-files")) return;
    const st = paneFor(current());
    const row = target.closest("[data-open]");
    if (row) return push({ kind: "file", path: row.dataset.open });
    const folderButton = target.closest("[data-folder]");
    if (folderButton) return push({ kind: "folder", path: folderButton.dataset.folder });
    const button = target.closest("[data-files]");
    const action = button?.dataset.files;
    if (action === "back") return back();
    if (action === "refresh") return refetch(st);
    if (action === "retry") return refetch(st);
    if (action === "more") {
      st.logsLoaded += 250;
      return rerender("more:logs");
    }
    if (action === "download") return download(st.stack.at(-1).path);
    if (action === "copy") {
      const path = st.stack.at(-1).path;
      return copyText(files[path].content, path.split("/").pop(), button, ".code-view, .reader-preview");
    }
    if (action === "sort") return openSort(button);
    if (action === "viewer") return CT.work.openViewer ? CT.work.openViewer("chart", button) : null;
    const viewButton = target.closest("[data-fileview]");
    if (viewButton) {
      st.stack.at(-1).view = viewButton.dataset.fileview;
      rerender();
      return $(`[data-fileview="${viewButton.dataset.fileview}"]`)?.focus();
    }
    const sortItem = target.closest("[data-sort]");
    if (sortItem) {
      st.sort = sortItem.dataset.sort;
      rerender();
      return $('[data-files="sort"]')?.focus();
    }
  });

  function openSort(button) {
    const st = paneFor(current());
    const existing = $(".files .menu");
    if (existing) {
      existing.remove();
      button.setAttribute("aria-expanded", "false");
      return;
    }
    const host = button.closest(".files");
    const menu = document.createElement("ul");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "Sort");
    menu.innerHTML = [
      ["name", "Name"],
      ["modified", "Modified, newest first"],
    ]
      .map(
        ([k, label]) =>
          `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${st.sort === k}" data-sort="${k}">${label}<span class="glyph" data-state="check"></span></button></li>`,
      )
      .join("");
    host.style.position = "relative";
    host.appendChild(menu);
    const r = button.getBoundingClientRect();
    menu.style.top = `${r.bottom - host.getBoundingClientRect().top + 4}px`;
    menu.style.right = "0px";
    button.setAttribute("aria-expanded", "true");
    $('[aria-checked="true"]', menu).focus();
  }

  document.addEventListener("input", (event) => {
    if (event.target.id !== "files-filter") return;
    const st = paneFor(current());
    st.filter = event.target.value;
    const pos = event.target.selectionStart;
    rerender();
    const field = $("#files-filter");
    field.focus();
    field.setSelectionRange(pos, pos);
  });

  // Keys: Back, rows, the view switch, the sort menu. Registered before app.js's own handler.
  document.addEventListener("keydown", (event) => {
    const target = event.target;
    const inFiles = target.closest?.("#panel-files");
    const sortMenu = $(".files .menu");
    if (sortMenu && ["ArrowDown", "ArrowUp", "Escape"].includes(event.key)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (event.key === "Escape") {
        sortMenu.remove();
        return $('[data-files="sort"]')?.focus();
      }
      const items = $$(".menu-item", sortMenu);
      const i = items.indexOf(document.activeElement);
      return items[(i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
    }
    // ⌘[ : Back in Files; in the conversation, back to the file "Show in chat" came from.
    if ((event.metaKey || event.ctrlKey) && event.key === "[") {
      if (inFiles) {
        event.preventDefault();
        return back();
      }
      const link = $("[data-back-to-file]");
      if (link) {
        event.preventDefault();
        return link.click();
      }
    }
    if (target.id === "files-filter" && event.key === "Escape" && target.value) {
      event.preventDefault();
      event.stopImmediatePropagation();
      paneFor(current()).filter = "";
      rerender();
      return $("#files-filter").focus();
    }
    // Escape goes Back while docked; as a drawer or sheet it closes the pane as always.
    if (inFiles && event.key === "Escape" && !app.overlaying() && paneFor(current()).stack.length) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return back();
    }
    if (inFiles && target.classList.contains("file-row") && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const rows = $$(".file-row", $("#panel-files"));
      const i = rows.indexOf(target);
      const next = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : Math.max(0, Math.min(rows.length - 1, i + (event.key === "ArrowDown" ? 1 : -1)));
      return rows[next].focus();
    }
    if (target.matches?.("[data-fileview]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = $$("[data-fileview]");
      const i = tabs.indexOf(target);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (i + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next].click();
    }
  });

  // Remember how far each level was scrolled.
  document.addEventListener(
    "scroll",
    (event) => {
      if (!event.target.classList?.contains("work-sections") || $("#panel-files").hidden) return;
      const t = current();
      if (t) paneFor(t).scroll[key(paneFor(t))] = event.target.scrollTop;
    },
    true,
  );

  // Controls in the prototype's bar for events that have no control in the app.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = $("#proto-extra");
    if (!extra) return;
    setTimeout(() => {
      extra.innerHTML =
        `<span class="run-controls"><button type="button" data-work="write">Otto edits the notes</button>` +
        `<button type="button" data-work="finish">The write finishes</button>` +
        `<button type="button" data-work="command">Otto runs a command</button>` +
        (CT.work.barExtra || "") +
        `<span id="run-caption">Open Files from the pane, or "Open file" on a step.</span></span>`;
    });
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-work]")?.dataset.work;
      if (!what) return;
      if (CT.work.bar?.(what)) return;
      const t = current();
      if (!t || t.id !== "o1") return CT.toast?.("Open Otto's task “Disk almost full on the media box” first.");
      if (what === "write") startWrite();
      if (what === "finish") finishWrite();
      if (what === "command") runCommand();
    });
  });

  CT.work = Object.assign(CT.work || {}, {
    files,
    paneFor,
    openFile,
    openLevel,
    showInChat,
    reveal,
    finishWrite,
    startWrite,
    runCommand,
    back,
    rerender,
    current,
    currentBot,
    size,
    middle,
    copyText,
    turn,
    bubble,
  });
})();
