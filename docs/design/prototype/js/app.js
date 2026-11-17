// The app page, driven by a small local model. No gateway, no network.
//
// Three things are tracked separately, as the design specifies: which bot is
// selected, which task is selected, and which bots are unfolded. One state
// object also holds the connection, so the status strip, the rail's footer,
// the title pill and the composer always agree.
//
// States can be set from the address, which is how the screenshots are taken:
//   ?bot=juniper&task=j2      open a bot and one of its tasks
//   ?unfold=juniper,pip       unfold more bots than the selected one
//   ?fold=otto                fold the selected bot
//   ?showall=otto             lift the six-row cap for a bot
//   ?rail=pinned              pin Pip and Juniper
//   ?panel=open&tab=files     the Work pane and its tab
//   ?view=list                the one-pane layout's list
//   ?banner=reconnecting      the connection: reconnecting, offline, syncing, synced, failed
//   ?state=empty              no task selected; also: loading, readonly, newtask, loaderror

(function () {
  const CT = window.CT;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);

  // Fixtures --------------------------------------------------------------------
  // at: minutes, for ordering by latest activity. when: how the time reads.

  const diskTranscript =
    `<div class="stamp">Today 5:31 PM</div>` +
    `<div class="msg" data-role="user"><div class="bubble">The media box says the disk is 94% full. What is eating the space?</div></div>` +
    `<details class="steps"><summary class="event-line">Used 2 tools ${icon("chevron")}</summary><ul class="steps-list">` +
    `<li class="step"><span class="step-tool-name">ls</span><span class="step-summary">path: .</span></li>` +
    `<li class="step"><span class="step-tool-name">read</span><span class="step-summary">path: AGENTS.md</span></li></ul></details>` +
    `<div class="msg" data-role="assistant"><div class="bubble md"><h3>Found</h3><p>The usual suspects on a media box, largest first:</p>` +
    `<ol><li><code>/var/lib/transcode-cache</code>, about 180 GB of temporary transcodes that were never cleaned up.</li>` +
    `<li>Old container images, about 40 GB across 12 unused tags.</li><li>Rotated logs, about 6 GB, mostly from one noisy service.</li></ol>` +
    `<h3>Changed</h3><p>Nothing yet.</p><h3>Left</h3><ul><li>Clearing the transcode cache is safe and frees the most. Its files are regenerated on demand.</li>` +
    `<li>Pruning unused images is also safe, but the next update will download them again.</li></ul></div></div>` +
    `<div class="msg" data-role="assistant"><div class="bubble">Should I clear the transcode cache? I will move it aside first so it can be restored.</div></div>` +
    `<div class="stamp">Today 5:36 PM</div>` +
    `<div class="msg" data-role="user"><div class="bubble">Yes, clear the transcode cache.</div></div>` +
    `<details class="steps"><summary class="event-line">Used 1 tool ${icon("chevron")}</summary><ul class="steps-list">` +
    `<li class="step"><span class="step-tool-name">write</span><span class="step-summary">path: notes/disk-2026-11-16.md</span></li></ul></details>` +
    `<div class="msg" data-role="assistant"><div class="bubble md"><p>Done. The disk is now at 61%.</p><table><thead><tr><th>What</th><th>Before</th><th>After</th></tr></thead>` +
    `<tbody><tr><td>Disk used</td><td>94%</td><td>61%</td></tr><tr><td>Transcode cache</td><td>180 GB</td><td>0 GB</td></tr><tr><td>Free space</td><td>33 GB</td><td>213 GB</td></tr></tbody></table>` +
    `<p>I moved the cache to <code>transcode-cache.old</code> instead of deleting it. To undo, move it back. I will remove it in a week unless you say otherwise.</p></div></div>`;

  const task = (id, title, at, when, preview, extra = {}) => ({ id, title, at, when, preview, unread: false, status: "idle", ...extra });

  const bots = [
    {
      id: "otto",
      name: "Otto",
      label: "Operations",
      tasks: [
        task("o1", "Disk almost full on the media box", 1056, "5:36 PM", "Done. The disk is now at 61%.", { html: diskTranscript }),
        task("o2", "Rotate the logs on every machine in the rack before the disks fill up again", 1100, "now", "Rotating logs on rack-2", { status: "running", ask: "Rotate the logs on every machine in the rack before the disks fill up again." }),
        task("o3", "Weekly backup check", 854, "2:14 PM", "Yes. Last night's backup finished at 3:25 AM.", { unread: true, ask: "Did last night's backup finish?" }),
        task("o4", "Certificate renewal warning", -1, "Mon", "A little. Renewal normally happens with 30 days left."),
        task("o5", "Router firmware", -2, "Mon", "The router is two releases behind. Neither is urgent."),
        task("o6", "Printer offline again", -3, "Sun", "It had fallen off the network. It is back, with a fixed address."),
        task("o7", "NAS scrub schedule", -4, "Sat", "The scrub now runs on the first Sunday of the month."),
        task("o8", "Why does the garage camera drop off the network every night around two", -5, "Fri", "It loses its lease at 2:04 every night. A reservation fixes it."),
        task("o9", "UPS battery report", -6, "Nov 6", "The battery holds 41 minutes at the current load."),
        task("o10", "Guest Wi-Fi password", -7, "Nov 5", "Changed, and the old one no longer works."),
        task("o11", "Media server update", -8, "Nov 3", "Updated. Two plugins needed their settings again."),
        task("o12", "Thermostat schedule", -9, "Nov 2", "Weekdays now start warming at 6:30."),
        task("o13", "DNS blocklist review", -10, "Oct 30", "Removed three lists that blocked the school's site."),
        task("o14", "Old tickets cleanup", -11, "Oct 28", "Closed 19 that were already done."),
      ],
    },
    {
      id: "juniper",
      name: "Juniper",
      label: "Research",
      tasks: [
        task("j1", "Heat pump vs. gas furnace", 1044, "5:24 PM", "Ask these five, and get the answers in writing.", { ask: "What should I ask an installer before signing anything?" }),
        task("j2", "Library e-book apps compared", 902, "3:02 PM", "Most public libraries use one of three lending platforms.", { unread: true, ask: "Which e-book app does my library use, and is it any good?" }),
        task("j3", "Caffeine cutoff time", -3, "Sun", "Short answer: stop about 8 hours before bed."),
      ],
    },
    {
      id: "marlow",
      name: "Marlow",
      label: "Writing",
      tasks: [task("m1", "Main", 1018, "4:58 PM", "Tightened the intro and cut about 80 words.", { ask: "Can you tighten the intro of the newsletter draft?" })],
    },
    {
      id: "pip",
      name: "Pip",
      label: "Planning",
      tasks: [
        task("p1", "Plan the week", 910, "3:10 PM", "Here is the week, with Thursday kept clear.", { unread: true, ask: "Plan my week. Keep Thursday clear." }),
        task("p2", "Trip to the coast in March", -1, "Mon", "Two options, both under four hours by train."),
        task("p3", "Birthday dinner", -4, "Sat", "Booked for eight people at 7:30."),
        task("p4", "Reading list for the spring", -9, "Nov 2", "Twelve books, shortest first."),
      ],
    },
  ];

  // The model ------------------------------------------------------------------------

  const model = {
    selectedBot: params.get("bot") || "otto",
    selectedTask: null, // set below
    remembered: { otto: "o1" }, // the last task opened for each bot
    unfolded: new Set(), // bots unfolded because they are open
    held: new Set(), // bots the user unfolded by hand; they stay unfolded
    showAll: new Set((params.get("showall") || "").split(",").filter(Boolean)),
    pinned: new Set(params.get("rail") === "pinned" ? ["pip", "juniper"] : []),
    connection: "connected",
    access: params.get("state") === "readonly" ? "read" : "write",
    loading: params.get("state") === "loading",
    loadError: params.get("state") === "loaderror",
    panel: false,
    tab: params.get("tab") || "details",
    drafts: {},
    newCount: 0,
  };

  const bot = (id = model.selectedBot) => bots.find((b) => b.id === id);
  const sorted = (b) => [...b.tasks].sort((x, y) => y.at - x.at);
  const currentTask = () => bot().tasks.find((t) => t.id === model.selectedTask) || null;

  // What a bot's row says about all of its tasks.
  function summary(b) {
    const tasks = sorted(b);
    const latest = tasks[0];
    const others = (t) => !(b.id === model.selectedBot && t.id === model.selectedTask);
    const state = tasks.some((t) => t.status === "failed") ? "failed" : tasks.some((t) => t.status === "running") ? "running" : "idle";
    return {
      preview: latest.preview, // from the latest activity in any task
      when: latest.when,
      unread: tasks.some((t) => t.unread && others(t)), // if any task is unread
      state, // by priority across tasks: failed, then running, then idle
    };
  }

  // The rows shown under an unfolded bot: six, then "Show all".
  function visible(b) {
    const tasks = sorted(b);
    if (tasks.length <= 6 || model.showAll.has(b.id)) return tasks;
    const top = tasks.slice(0, 6);
    const current = tasks.find((t) => t.id === model.selectedTask && b.id === model.selectedBot);
    if (current && !top.includes(current)) top[5] = current; // the current task is always in view
    return top;
  }

  const isOpen = (b) => b.tasks.length > 1 && (model.unfolded.has(b.id) || model.held.has(b.id));
  const onePane = () => getComputedStyle($(".back-button")).display !== "none";
  const shell = $(".shell");

  // Rail ---------------------------------------------------------------------------------

  function taskRows(b) {
    const rows = visible(b)
      .map((t) => {
        const current = b.id === model.selectedBot && t.id === model.selectedTask;
        const mark =
          t.status === "running"
            ? `<span class="glyph" data-state="working" aria-hidden="true"></span>`
            : t.status === "failed"
              ? `<span class="glyph" data-state="failed" aria-hidden="true"></span>`
              : t.unread && !current
                ? `<span class="unread-dot" aria-hidden="true"></span>`
                : "";
        const spoken = t.title + (t.status === "running" ? ", working" : t.status === "failed" ? ", last run failed" : t.unread && !current ? ", unread" : "");
        return (
          `<li><button type="button" class="task" data-bot="${b.id}" data-task="${t.id}" data-key="t:${t.id}" aria-current="${current}"` +
          ` data-status="${t.status}" data-unread="${t.unread && !current}" data-full="${esc(t.title)}" data-when="${esc(t.when)}"` +
          ` aria-label="${esc(spoken)}" data-testid="task"><span class="task-title">${esc(t.title)}</span>${mark}</button></li>`
        );
      })
      .join("");
    const more =
      b.tasks.length > 6
        ? `<li><button type="button" class="task task-more" data-more="${b.id}" data-key="more:${b.id}"><span class="task-title">` +
          `${model.showAll.has(b.id) ? "Show fewer" : `Show all ${b.tasks.length}`}</span></button></li>`
        : "";
    return (
      rows +
      more +
      `<li><button type="button" class="task task-new" data-new="${b.id}" data-key="new:${b.id}">${icon("plus")}<span class="task-title">New task</span></button></li>`
    );
  }

  function botLines(b) {
    const s = summary(b);
    const lead =
      s.state === "running"
        ? `<span class="glyph" data-state="working" aria-hidden="true"></span>`
        : s.state === "failed"
          ? `<span class="glyph" data-state="failed" aria-hidden="true"></span>`
          : "";
    return {
      s,
      html:
        `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${s.when}</time></span>` +
        `<span class="bot-line">${lead}<span class="bot-preview">${esc(s.preview)}</span>${s.unread ? '<span class="unread-dot"></span>' : ""}</span></span>`,
    };
  }

  const spokenBot = (b, s) =>
    `${b.name}, ${b.tasks.length} ${b.tasks.length === 1 ? "task" : "tasks"}` +
    (s.state === "running" ? ", working" : s.state === "failed" ? ", a run failed" : "") +
    (s.unread ? ", unread" : "");

  function renderRail() {
    const focusKey = document.activeElement?.dataset?.key;
    const list = $("#bot-list");
    const pinned = bots.filter((b) => model.pinned.has(b.id));
    const rest = bots.filter((b) => !model.pinned.has(b.id)).sort((x, y) => sorted(y)[0].at - sorted(x)[0].at);
    let html = "";

    if (pinned.length) {
      html +=
        `<li><ul class="pin-grid" aria-label="Pinned bots">` +
        pinned
          .map((b) => {
            const s = summary(b);
            const selected = b.id === model.selectedBot;
            const mark =
              s.state === "running"
                ? `<span class="glyph" data-state="working" aria-hidden="true"></span>`
                : s.unread
                  ? `<span class="unread-dot" aria-hidden="true"></span>`
                  : "";
            return (
              `<li><button type="button" class="pin" data-bot="${b.id}" data-key="b:${b.id}" aria-current="${selected}"` +
              `${b.tasks.length > 1 ? ` aria-expanded="${isOpen(b)}"` : ""} aria-label="${esc(spokenBot(b, s))}" data-testid="bot">` +
              `<span class="avatar" data-bot="${b.id}"></span><span class="pin-name"><span>${b.name}</span>${mark}</span></button></li>`
            );
          })
          .join("") +
        `</ul></li>`;
      // The tasks of an open pinned bot sit in a block right under the tiles.
      const open = pinned.find((b) => isOpen(b));
      if (open) html += `<li class="pin-tasks"><ul class="task-list" aria-label="${open.name}'s tasks" data-testid="task-list">${taskRows(open)}</ul></li>`;
    }

    html += rest
      .map((b) => {
        const { s, html: lines } = botLines(b);
        const open = isOpen(b);
        const single = b.tasks.length === 1;
        const selected = b.id === model.selectedBot;
        return (
          `<li class="bot-group"${open ? ' data-open="true"' : ""}>` +
          `<button type="button" class="bot" data-bot="${b.id}" data-key="b:${b.id}" aria-current="${selected && (single || !open)}"` +
          `${single ? "" : ` aria-expanded="${open}"`} aria-label="${esc(spokenBot(b, s))}" data-testid="bot">` +
          `<span class="avatar" data-bot="${b.id}"></span>${lines}</button>` +
          (single
            ? ""
            : `<button type="button" class="icon-button bot-toggle" data-toggle="${b.id}" tabindex="-1" aria-label="${open ? "Hide" : "Show"} ${b.name}'s tasks">${icon("chevron")}</button>`) +
          (open ? `<ul class="task-list" aria-label="${b.name}'s tasks" data-testid="task-list">${taskRows(b)}</ul>` : "") +
          `</li>`
        );
      })
      .join("");

    list.innerHTML = html;
    CT.hydrate(list);
    if (focusKey) $(`[data-key="${focusKey}"]`, list)?.focus();
  }

  // Selecting, folding, new task ---------------------------------------------------------

  function selectBot(id) {
    const b = bot(id);
    if (id !== model.selectedBot) {
      model.unfolded.clear();
      model.selectedBot = id;
      // The task last opened for this bot, or else its most recent one.
      model.selectedTask = b.tasks.find((t) => t.id === model.remembered[id])?.id || sorted(b)[0].id;
    }
    model.unfolded.add(id);
    openTask(id, model.selectedTask);
  }

  function openTask(botId, taskId) {
    model.selectedBot = botId;
    model.selectedTask = taskId;
    model.remembered[botId] = taskId;
    model.unfolded.add(botId);
    const t = currentTask();
    if (t) t.unread = false; // opening a task marks it read
    model.loading = false;
    model.loadError = false;
    shell.dataset.view = "detail";
    render();
    const transcript = $("#transcript");
    transcript.scrollTop = transcript.scrollHeight;
  }

  function toggleFold(id) {
    const b = bot(id);
    if (b.tasks.length < 2) return;
    if (isOpen(b)) {
      model.unfolded.delete(id);
      model.held.delete(id);
    } else {
      model.held.add(id);
    }
    renderRail();
  }

  function newTask(id) {
    const b = bot(id);
    model.newCount += 1;
    const t = task(`n${model.newCount}`, "New task", 2000 + model.newCount, "now", "No messages yet.", { html: "", fresh: true });
    b.tasks.push(t);
    openTask(id, t.id);
    $(".composer-input")?.focus();
    note("New task: an empty task under the bot, selected, with the composer focused.");
  }

  // Conversation -------------------------------------------------------------------------

  function renderHeader() {
    const b = bot();
    const t = currentTask();
    const pill = $("#title-pill");
    pill.innerHTML =
      `<span class="avatar" data-bot="${b.id}"></span><span class="title-pill-name">${b.name}</span>` +
      (t ? `<span class="title-pill-task">${esc(t.title)}</span>` : "");
    pill.setAttribute("aria-label", t ? `${b.name}, ${t.title}. Show details.` : `${b.name}. Show details.`);
    pill.title = t ? t.title : "";
    CT.hydrate(pill);
  }

  function renderTranscript() {
    const b = bot();
    const t = currentTask();
    const el = $("#transcript");
    if (!t) {
      el.innerHTML =
        `<div class="empty"><div><span class="avatar" data-bot="${b.id}"></span><h3>Pick a task</h3>` +
        `<p>Choose one of ${b.name}'s tasks, or start a new one.</p>` +
        `<div class="empty-actions"><button type="button" class="button" data-variant="primary" data-new="${b.id}">New task</button>` +
        (onePane() ? `<button type="button" class="button" data-action="back">Choose a task</button>` : "") +
        `</div></div></div>`;
    } else if (model.loading) {
      el.innerHTML =
        `<div class="transcript-inner" aria-busy="true" aria-label="Loading conversation"><p class="task-line">${esc(t.title)}</p>` +
        `<div class="skeleton" style="width:46%;margin-left:auto;margin-top:22px"></div>` +
        `<div class="skeleton" style="width:62%;height:88px;margin-top:16px"></div><div class="skeleton" style="width:38%"></div></div>`;
    } else if (t.fresh && !t.html) {
      el.innerHTML =
        `<div class="empty"><div><span class="avatar" data-bot="${b.id}"></span><h3>Nothing here yet</h3>` +
        `<p>Say what you need, and ${b.name} will take it from there.</p></div></div>`;
    } else {
      const body =
        t.html ??
        `<div class="stamp">${t.at > 0 ? "Today " : ""}${t.when}</div>` +
          `<div class="msg" data-role="user"><div class="bubble">${esc(t.ask || t.title + "?")}</div></div>` +
          `<div class="msg" data-role="assistant"><div class="bubble">${esc(t.preview)}</div></div>`;
      // When a refresh fails, what was last loaded stays, under one line that says so.
      const error = model.loadError
        ? `<p class="load-note" role="alert">Couldn't refresh this conversation. Showing what was loaded before.` +
          `<button type="button" class="button" data-size="sm" data-action="reload">Try again</button></p>`
        : "";
      el.innerHTML = `<div class="transcript-inner"><p class="task-line">${esc(t.title)}</p>${error}${body}</div>`;
    }
    CT.hydrate(el);
  }

  function renderComposer() {
    const b = bot();
    const t = currentTask();
    const el = $("#composer");
    el.hidden = !t; // with no task there is nothing to send to
    if (!t) return;
    const offline = model.connection === "reconnecting" || model.connection === "offline";
    if (model.access === "read") {
      el.dataset.readonly = "true";
      el.innerHTML = `<div class="composer-inner"><div class="composer-box">${icon("eye")}<span>This device can read but not send. Ask the gateway owner for write access.</span></div></div>`;
      return;
    }
    delete el.dataset.readonly;
    const draft = model.drafts[t.id] || "";
    el.innerHTML =
      `<div class="composer-inner"><div class="composer-box">` +
      `<button type="button" class="icon-button" data-action="attach" aria-label="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" rows="1" aria-label="Message ${b.name}" placeholder="${offline ? "Offline. You can keep writing." : `Message ${b.name}`}">${esc(draft)}</textarea>` +
      `<button type="button" class="icon-button send-button" data-action="send" aria-label="Send"${draft && !offline ? "" : " disabled"}>${icon("arrow-up")}</button>` +
      `</div></div>`;
  }

  function send() {
    const t = currentTask();
    const text = (model.drafts[t.id] || "").trim();
    if (!text) return;
    t.html = (t.html ?? $("#transcript .transcript-inner").innerHTML.replace(/<p class="task-line">.*?<\/p>/, "")) +
      `<div class="msg" data-role="user"><div class="bubble">${esc(text)}</div></div>` +
      `<div class="event-line">Sent. This prototype has no gateway, so nothing answers.</div>`;
    t.preview = text;
    t.fresh = false;
    model.drafts[t.id] = "";
    render();
    const transcript = $("#transcript");
    transcript.scrollTop = transcript.scrollHeight;
    $(".composer-input")?.focus();
  }

  // Work pane ---------------------------------------------------------------------------------

  const panel = $("#work-panel");
  const overlaying = () => getComputedStyle(panel).position === "absolute";
  let opener = null;

  function renderPanel() {
    const b = bot();
    const t = currentTask();
    $("#work-hero").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><h2>${b.name}</h2><p>${b.label}</p>`;
    CT.hydrate($("#work-hero"));
    $("#panel-details").innerHTML = t
      ? `<p class="work-task">${esc(t.title)}</p>` +
        `<dl class="facts"><div><dt>Model</dt><dd>scripted/dev-1</dd></div><div><dt>Runs on</dt><dd>Gateway host</dd></div>` +
        `<div><dt>Last activity</dt><dd>${t.at > 0 ? "Today, " : ""}${t.when}</dd></div></dl>` +
        `<section class="work-section"><h3>Routines</h3><p class="work-note">None yet. Ask ${b.name} to do something on a schedule.</p></section>`
      : `<p class="work-note">No task is open. Pick one of ${b.name}'s tasks to see its details.</p>`;
    $("#files-empty").textContent = `Files ${b.name} reads or writes in this task appear here.`;
    $("#computer-empty").textContent = `When ${b.name} uses a browser or a desktop, you can watch it here.`;
    setTab(model.tab);
  }

  function setTab(name, focus = false) {
    model.tab = name;
    $$("[data-tab]").forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1; // one tab stop; arrows move between tabs
      if (on && focus) tab.focus();
    });
    $$('[role="tabpanel"]').forEach((p) => (p.hidden = p.id !== `panel-${name}`));
  }

  // Opening or closing the pane keeps the reader's place: the bottom stays the
  // bottom, and otherwise the first message in view stays where it was.
  function holdPlace(change) {
    const el = $("#transcript");
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    const top = el.getBoundingClientRect().top + 70;
    const anchor = atEnd ? null : $$(".msg, .stamp, .steps", el).find((node) => node.getBoundingClientRect().bottom > top);
    const before = anchor?.getBoundingClientRect().top;
    change();
    if (atEnd) el.scrollTop = el.scrollHeight;
    else if (anchor) el.scrollTop += anchor.getBoundingClientRect().top - before;
  }

  // As a drawer the pane is modal: focus moves in and stays in, and what is
  // behind it is inert. Docked, it is an ordinary part of the page.
  function applyModality() {
    const modal = model.panel && overlaying();
    $(".rail").inert = modal;
    $(".conversation").inert = modal;
    if (modal) {
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-modal", "true");
    } else {
      panel.removeAttribute("role");
      panel.removeAttribute("aria-modal");
    }
    return modal;
  }

  function setPanel(open, { focus = true } = {}) {
    if (open === model.panel) return;
    if (open) opener = document.activeElement;
    holdPlace(() => {
      model.panel = open;
      shell.dataset.panel = open ? "open" : "closed";
    });
    const button = $("#panel-button");
    button.setAttribute("aria-pressed", String(open));
    button.setAttribute("aria-label", open ? "Hide work pane" : "Show work pane");
    const modal = applyModality();
    if (open && modal && focus) $(".work-close").focus();
    if (!open && opener && document.contains(opener)) opener.focus();
  }

  // Crossing the docking width while the pane is open changes whether it is modal.
  new ResizeObserver(() => {
    applyModality();
    const el = $("#transcript");
    if (el.dataset.atEnd === "true") el.scrollTop = el.scrollHeight; // the bottom stays the bottom through any reflow
  }).observe($(".main-pane"));

  // Connection ------------------------------------------------------------------------------------

  const connections = {
    connected: { dot: "connected", footer: "Connected" },
    reconnecting: { dot: "reconnecting", footer: "Reconnecting…", tone: "warn", text: "Reconnecting", more: "showing saved messages", action: "Retry now" },
    offline: { dot: "error", footer: "Can't reach the gateway", tone: "danger", text: "Can't reach Home gateway", more: "showing saved messages", action: "Retry now" },
    syncing: { dot: "connecting", footer: "Catching up", tone: "warn", text: "Connected", more: "catching up" },
    synced: { dot: "connected", footer: "Connected", tone: "ok", text: "Synced", more: "1 new in this task" },
    failed: { dot: "connected", footer: "Connected", tone: "danger", text: "Couldn't sync this task", action: "Try again" },
  };
  let connectionTimer = null;

  function setConnection(name) {
    clearTimeout(connectionTimer);
    model.connection = name;
    const c = connections[name];
    // One state drives the strip, both status dots, the footer and the composer.
    $$(".rail .status-dot").forEach((dot) => (dot.dataset.status = c.dot));
    $("#gateway-state").textContent = c.footer;
    $("#gateway-menu-state").textContent = `${c.footer} · gateway.local`;
    $$('[data-action="gateway-menu"]').forEach((button) => button.setAttribute("aria-label", `Home gateway, ${c.footer.toLowerCase()}. Open the gateway menu.`));
    const strip = $("#status-strip");
    strip.hidden = !c.text;
    $(".conversation").dataset.strip = String(Boolean(c.text));
    if (c.text) {
      strip.dataset.tone = c.tone;
      strip.innerHTML =
        `<span class="status-dot" data-status="${c.dot}"></span><span class="status-strip-text">${c.text}` +
        `${c.more ? `<span>· ${c.more}</span>` : ""}</span>${c.action ? `<button type="button" data-action="retry">${c.action}</button>` : ""}`;
    }
    renderComposer();
    if (name === "syncing") connectionTimer = setTimeout(() => arrive(), 900);
    if (name === "synced") connectionTimer = setTimeout(() => setConnection("connected"), 4000); // leaves after 4 seconds
  }

  // What was missed arrives: merged into the open task, without moving the reader.
  function arrive() {
    const t = currentTask();
    const el = $("#transcript");
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    if (t && t.html !== undefined && !t.fresh) {
      t.html += `<div class="msg" data-role="assistant"><div class="bubble">While you were offline: the old cache folder is still untouched. I will remove it next Monday.</div></div>`;
      const top = el.scrollTop;
      renderTranscript();
      el.scrollTop = atEnd ? el.scrollHeight : top;
      $("#jump-latest").hidden = atEnd;
    }
    setConnection("synced");
  }

  // Everything ------------------------------------------------------------------------------------

  function render() {
    renderRail();
    renderHeader();
    renderTranscript();
    renderComposer();
    renderPanel();
  }

  function note(text) {
    const node = $("#run-caption");
    if (node) node.textContent = text;
  }

  // Gateway menu ------------------------------------------------------------------------------------

  const menu = $("#gateway-menu");
  let menuOpener = null;

  function setMenu(open, from) {
    menu.hidden = !open;
    $$('[data-action="gateway-menu"]').forEach((button) => button.setAttribute("aria-expanded", String(open)));
    if (open) {
      menuOpener = from;
      const stored = CT.settings.followSystem ? "system" : CT.settings.theme;
      $$("[data-theme-choice]").forEach((item) => item.setAttribute("aria-checked", String(item.dataset.themeChoice === stored)));
      ($('[data-theme-choice][aria-checked="true"]') || $(".menu-item", menu)).focus();
    } else if (menuOpener) {
      menuOpener.focus();
      menuOpener = null;
    }
  }

  // Wiring --------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!menu.hidden && !target.closest("#gateway-menu, [data-action='gateway-menu']")) setMenu(false);

    const toggle = target.closest("[data-toggle]");
    if (toggle) return toggleFold(toggle.dataset.toggle);

    const more = target.closest("[data-more]");
    if (more) {
      const id = more.dataset.more;
      if (model.showAll.has(id)) model.showAll.delete(id);
      else model.showAll.add(id);
      return renderRail();
    }

    const fresh = target.closest("[data-new]");
    if (fresh) return newTask(fresh.dataset.new);

    const row = target.closest(".task[data-task]");
    if (row) return openTask(row.dataset.bot, row.dataset.task);

    const botRow = target.closest(".bot, .pin");
    if (botRow) {
      const id = botRow.dataset.bot;
      const b = bot(id);
      if (b.tasks.length === 1) return selectBot(id);
      // One pane: a bot with several tasks unfolds in place; a task opens.
      if (onePane()) return toggleFold(id);
      // Two panes: opening a bot opens its task and unfolds it; the open bot folds and unfolds.
      if (id === model.selectedBot) return toggleFold(id);
      return selectBot(id);
    }

    const theme = target.closest("[data-theme-choice]");
    if (theme) {
      CT.setTheme(theme.dataset.themeChoice);
      return setMenu(false);
    }

    const tab = target.closest("[data-tab]");
    if (tab) return setTab(tab.dataset.tab);

    const action = target.closest("[data-action]")?.dataset.action;
    if (action === "panel") setPanel(!model.panel);
    if (action === "panel-close") setPanel(false);
    if (action === "back") {
      shell.dataset.view = "list";
      renderRail();
    }
    if (action === "gateway-menu") setMenu(menu.hidden, target.closest("button"));
    if (action === "disconnect") location.href = "connect.html" + location.search;
    if (action === "retry") setConnection("syncing");
    if (action === "reload") {
      model.loadError = false;
      renderTranscript();
      note("Try again: the conversation loaded.");
    }
    if (action === "send") send();
    if (action === "jump") {
      const el = $("#transcript");
      el.scrollTop = el.scrollHeight;
    }
    if (action === "search") note("Search is not part of this prototype.");
    if (action === "new-bot") note("Creating a bot is not part of this prototype.");
    if (action === "attach") note("Attaching files is not part of this prototype.");
  });

  document.addEventListener("input", (event) => {
    if (!event.target.classList.contains("composer-input")) return;
    const t = currentTask();
    model.drafts[t.id] = event.target.value;
    const offline = model.connection === "reconnecting" || model.connection === "offline";
    $(".send-button").disabled = !event.target.value.trim() || offline;
  });

  $("#transcript").addEventListener("scroll", (event) => {
    const el = event.currentTarget;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 96;
    el.dataset.atEnd = String(atEnd);
    if (atEnd) $("#jump-latest").hidden = true;
  });

  document.addEventListener("keydown", (event) => {
    const target = event.target;

    if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      event.preventDefault();
      return setPanel(!model.panel);
    }
    if (event.key === "Escape") {
      if (!menu.hidden) return setMenu(false);
      if (model.panel && overlaying()) return setPanel(false);
    }
    if (event.key === "Enter" && !event.shiftKey && target.classList?.contains("composer-input")) {
      event.preventDefault();
      return send();
    }

    // The drawer keeps focus inside itself.
    if (event.key === "Tab" && model.panel && overlaying()) {
      const items = $$("button, [tabindex='0']", panel).filter((el) => !el.closest("[hidden]") && el.tabIndex >= 0);
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Tabs: Left and Right move and select; Home and End go to the ends.
    if (target.matches?.("[data-tab]") && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const tabs = $$("[data-tab]");
      const index = tabs.indexOf(target);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      return setTab(tabs[next].dataset.tab, true);
    }

    // The menu: Up and Down move between items.
    if (!menu.hidden && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const items = $$(".menu-item", menu);
      const index = items.indexOf(document.activeElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      return items[next].focus();
    }

    // The rail: Up and Down move through the rows; Right unfolds a bot, Left folds it.
    const row = target.closest?.("#bot-list .bot, #bot-list .pin, #bot-list .task");
    if (row) {
      const rows = $$("#bot-list .bot, #bot-list .pin, #bot-list .task");
      const index = rows.indexOf(row);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        rows[Math.min(rows.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))].focus();
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        rows[event.key === "Home" ? 0 : rows.length - 1].focus();
      } else if (event.key === "ArrowRight" && row.dataset.bot && !row.dataset.task && !isOpen(bot(row.dataset.bot))) {
        event.preventDefault();
        toggleFold(row.dataset.bot);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        if (row.classList.contains("task")) {
          const owner = row.dataset.bot || row.dataset.more || row.dataset.new;
          $(`[data-key="b:${owner}"]`)?.focus();
        } else if (isOpen(bot(row.dataset.bot))) {
          toggleFold(row.dataset.bot);
        }
      }
    }
  });

  // The full title of a truncated task, on hover and on keyboard focus.
  const tip = $("#rail-tooltip");
  function showTip(row) {
    const title = $(".task-title", row);
    if (!row.dataset.full || title.scrollWidth <= title.clientWidth) return hideTip();
    const rect = row.getBoundingClientRect();
    tip.textContent = row.dataset.full;
    tip.hidden = false;
    const fits = rect.right + 12 + tip.offsetWidth < innerWidth;
    tip.style.left = fits ? `${rect.right + 8}px` : `${Math.max(8, rect.left)}px`;
    tip.style.top = fits ? `${rect.top + rect.height / 2}px` : `${rect.bottom + 18}px`;
  }
  const hideTip = () => (tip.hidden = true);
  $("#bot-list").addEventListener("mouseover", (event) => {
    const row = event.target.closest(".task[data-task]");
    if (row) showTip(row);
    else hideTip();
  });
  $("#bot-list").addEventListener("mouseleave", hideTip);
  $("#bot-list").addEventListener("focusin", (event) => {
    const row = event.target.closest(".task[data-task]");
    if (row && row.matches(":focus-visible")) showTip(row);
    else hideTip();
  });
  $("#bot-list").addEventListener("focusout", hideTip);
  $("#bot-list").addEventListener("scroll", hideTip);

  // First paint -----------------------------------------------------------------------------------------

  const startBot = bot();
  model.selectedTask =
    params.get("state") === "empty" ? null : params.get("task") || model.remembered[startBot.id] || sorted(startBot)[0].id;
  if (!(params.get("fold") || "").split(",").includes(startBot.id)) model.unfolded.add(startBot.id);
  (params.get("unfold") || "").split(",").filter(Boolean).forEach((id) => model.held.add(id));
  if (params.get("view")) shell.dataset.view = params.get("view");
  const opened = currentTask();
  if (opened) opened.unread = false;

  render();
  setConnection(params.get("banner") || "connected");
  if (params.get("state") === "newtask") newTask(startBot.id);
  if (params.get("panel") === "open") setPanel(true, { focus: false });
  const transcript = $("#transcript");
  transcript.scrollTop = transcript.scrollHeight;
  transcript.dataset.atEnd = "true";

  // Controls in the prototype's bar, for the states that have no control in the app.
  const extra = $("#proto-extra");
  if (extra) {
    extra.innerHTML =
      `<span class="run-controls"><button type="button" data-fixture="pins">Pins</button>` +
      `<button type="button" data-fixture="offline">Go offline</button>` +
      `<button type="button" data-fixture="readonly">Read-only</button>` +
      `<button type="button" data-fixture="notask">No task</button>` +
      `<span id="run-caption">Click bots and tasks. Arrow keys move through the rail.</span></span>`;
    extra.addEventListener("click", (event) => {
      const fixture = event.target.closest("[data-fixture]")?.dataset.fixture;
      if (fixture === "pins") {
        if (model.pinned.size) model.pinned.clear();
        else ["pip", "juniper"].forEach((id) => model.pinned.add(id));
        renderRail();
      }
      if (fixture === "offline") setConnection(model.connection === "connected" ? "reconnecting" : "connected");
      if (fixture === "readonly") {
        model.access = model.access === "read" ? "write" : "read";
        renderComposer();
      }
      if (fixture === "notask") {
        model.selectedTask = null;
        render();
      }
    });
  }

  window.app = { model, setConnection, setPanel, openTask, selectBot, toggleFold, newTask };
})();
