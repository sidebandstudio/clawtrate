// notifications.html: docs/design/notifications.md. When a notification is
// shown, what it says, what a click opens, and the settings that decide it.
// The host's decision (section 3) is one function, `decide`; opening (section
// 5) is `open`. Every bot, task and reply is a local fixture. A notification is
// drawn as a labelled picture: the system draws the real one.
//
// Address parameters (section 15 of the design lists them):
//   open=settings|bot|details   event=<kind>   device=sender|other|read
//   focus=<bot>  quiet=1  os=mac|windows|linux  master/previews/budgetsw=0|1
//   bot=otto=off  task=on|off  click=gone|offline|othergw|stale
//   prefs=reading|readfail|device|conflict|savefail|elsewhere  access=read
//   failed=1  tasks=full

(function () {
  const CT = window.CT;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const glyph = (state) => CT.glyph(state);
  const LOGO = "../../../packages/ui/src/assets/logo-mark.png";
  // A bell, drawn for this prototype.
  const BELL =
    '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a3.6 3.6 0 0 0-3.6 3.6v2.3L3.2 10.4h9.6l-1.2-2.3V5.8A3.6 3.6 0 0 0 8 2.2Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6.6 12.4a1.5 1.5 0 0 0 2.8 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';

  // Fixtures ---------------------------------------------------------------------------------------

  const task = (id, title, when, ask, reply, extra = {}) => ({ id, title, when, ask, reply, wait: null, status: "idle", unread: false, ...extra });
  const BOTS = [
    { id: "juniper", name: "Juniper", label: "Research", tasks: [task("j1", "Heat pump vs. gas furnace", "5:24 PM", "Compare a heat pump with a gas furnace for this house.", "Here's the comparison, with ten-year running costs.")] },
    { id: "marlow", name: "Marlow", label: "Writing", tasks: [task("m1", "Notes for Pip", "4:58 PM", null, "Noted. I'll fold it into the plan.", { from: "pip" })] },
    {
      id: "otto",
      name: "Otto",
      label: "Operations",
      tasks: [
        task("o1", "Disk almost full on the media box", "5:36 PM", "Free up space on the media box.", "The transcode cache is the largest folder."),
        task("o3", "Weekly backup check", "2:14 PM", "Did last night's backup finish?", "Yes. Last night's backup finished at 3:25 AM, and the copy checked out."),
        task("o4", "Certificate renewal warning", "Mon", "Is the certificate warning urgent?", "A little. Renewal normally happens with 30 days left."),
        task("o5", "Router firmware", "Mon", "Is the router firmware current?", "The router is two releases behind."),
      ],
    },
    { id: "pip", name: "Pip", label: "Planning", tasks: [task("p1", "Plan the week", "3:10 PM", "Plan my week. Keep Thursday clear.", "Here is the week, with Thursday kept clear.")] },
  ];
  const bot = (id) => BOTS.find((b) => b.id === id);
  const findTask = (id) => {
    for (const b of BOTS) for (const t of b.tasks) if (t.id === id) return { b, t };
    return null;
  };
  // 39 other tasks with their own setting, for tasks=full.
  const FILLER = Array.from({ length: 39 }, (_, i) => [`x${i}`, i % 2 ? "on" : "off"]);

  // The events of the prototype's bar, and what each carries (section 3).
  const EVENTS = {
    finished: { label: "Otto finishes", bot: "otto", task: "o3", kind: "finished" },
    failed: { label: "Otto's run fails", bot: "otto", task: "o5", kind: "failed" },
    stopped: { label: "Otto's run is stopped", bot: "otto", task: "o3", kind: "stopped" },
    approval: { label: "Otto asks to run a command", bot: "otto", task: "o1", kind: "approval", command: "du -sh /var/lib/transcode-cache" },
    question: { label: "Juniper asks a question", bot: "juniper", task: "j1", kind: "question", question: "Which matters more to you: running cost or upfront price?" },
    marlow: { label: "Marlow asks, for Pip's message", bot: "marlow", task: "m1", kind: "question", question: "Should the plan keep Saturday morning free?", via: "pip" },
    budget: { label: "Otto passes 80% of its budget", bot: "otto", task: "o1", kind: "budget" },
  };

  // State --------------------------------------------------------------------------------------------

  const S = {
    os: ["mac", "windows", "linux"].includes(p("os")) ? p("os") : "mac",
    device: ["sender", "other", "read"].includes(p("device")) ? p("device") : "sender",
    master: p("master") !== "0",
    previews: p("previews") === "1",
    budgetsw: p("budgetsw") !== "0",
    bots: { juniper: true, marlow: true, otto: p("bot") !== "otto=off", pip: true },
    tasks: Object.assign({ o4: "off" }, p("task") ? { o3: p("task") } : {}, p("tasks") === "full" ? Object.fromEntries(FILLER) : {}),
    quiet: { enabled: p("quiet") === "1" || p("quietset") === "1", from: "22:00", to: "07:00" },
    quietNow: p("quiet") === "1",
    focus: p("focus") || null, // the bot on screen in a focused window
    click: p("click") || "", // what the host finds at a click
    prefs: p("prefs") || "ok", // reading, readfail, device, conflict, savefail, elsewhere
    access: p("access") === "read" ? "read" : "write",
    req: "none", // the access bar's request
    failedAt: p("failed") === "1" ? "5:41 PM" : null,
    sel: { bot: "otto", task: "o1" },
    panel: false,
    tab: "details",
    bview: "main",
    view: "detail",
    strip: null,
    pics: [], // pictures shown, newest first
    held: [], // waits held during quiet hours
    why: "", // what the host decided when nothing was shown
    saving: null, // the control being saved
    error: {}, // a control's "Couldn't save" line
    conflictNote: false,
    timeError: false,
    taskLimit: false,
    resolved: new Set(), // waits answered or ended
    sectionOpen: "notifications",
    settingsPane: "section",
  };
  if (S.prefs === "conflict" || S.prefs === "savefail") S.prefsFail = S.prefs; // the next write ends that way
  const sharedReadable = () => S.prefs !== "reading" && S.prefs !== "readfail";
  const canChangeShared = () => S.access !== "read" && sharedReadable();

  // The host's decision (section 3) ------------------------------------------------------------------

  const eff = (ev) => {
    const own = S.tasks[ev.task];
    if (own === "on") return true;
    if (own === "off") return false;
    return S.bots[ev.bot];
  };

  /** Returns { show: picture } or { hold: why } or { none: why }, by the design's order. */
  function decide(ev) {
    const b = bot(ev.bot);
    if (!S.master) return { none: "Show notifications is off on this computer." };
    if (!sharedReadable()) return { none: "Your settings haven't been read from the gateway, so no notification about a bot is shown." };
    if (ev.kind === "stopped") return { none: "A stopped run isn't notified: someone chose to stop it." };
    if (ev.kind === "question" && S.device === "read") return { none: "A read-only device receives nothing that says a question waits." };
    if (ev.kind === "budget") {
      if (!S.budgetsw) return { none: "Budget warnings are off on this computer." };
    } else if (!eff(ev)) {
      return { none: S.tasks[ev.task] === "off" ? `This task's notifications are off.` : `Notifications for ${b.name} are off.` };
    }
    if (S.focus) {
      if (S.os === "linux") return { none: "Clawtrate's window is focused. On Linux nothing is shown then." };
      if (S.focus === ev.bot) return { none: `${b.name} is on screen in the focused window.` };
    }
    if (S.quietNow) {
      const wait = ev.kind === "approval" || ev.kind === "question";
      return wait ? { hold: `Held until ${S.quiet.to}: ${b.name} is waiting for you.` } : { none: "Quiet hours: this is never shown later. The rail and the task hold it." };
    }
    return { show: picture(ev) };
  }

  // What a notification says (section 4).
  function picture(ev) {
    const b = bot(ev.bot);
    const { t } = findTask(ev.task);
    let body;
    let preview = "";
    if (ev.kind === "finished") (body = "Finished."), (preview = `${t.title}: ${t.reply}`);
    if (ev.kind === "failed") (body = "Its run failed."), (preview = t.title);
    if (ev.kind === "approval") {
      if (S.device === "sender") (body = "Wants to run a command."), (preview = `${t.title}: ${ev.command}`);
      else if (S.device === "other") (body = "Is waiting for an approval. It can be answered on the device that sent the message."), (preview = t.title);
      else (body = "Is waiting for an approval. This device can only read."), (preview = t.title);
    }
    if (ev.kind === "question") (body = "Asked you a question."), (preview = `${t.title}: ${ev.question}`);
    if (ev.kind === "budget") body = "Used 82% of its weekly budget. Shown only: nothing was stopped.";
    if (ev.kind === "budget") preview = "";
    return { id: `${ev.task}:${ev.kind}`, ev, title: b.name, body, preview: S.previews ? cut(preview, 90) : "" };
  }
  const cut = (text, n) => (text.length <= n ? text : `${text.slice(0, text.lastIndexOf(" ", n - 1))}…`);

  function fire(name) {
    const ev = EVENTS[name];
    if (!ev) return;
    S.resolved.delete(`${ev.task}:${ev.kind}`);
    markRail(ev);
    const outcome = decide(ev);
    if (outcome.show) {
      // One per task: a newer one for the task replaces the one shown.
      S.pics = [outcome.show, ...S.pics.filter((x) => x.ev.task !== ev.task)];
      S.why = "";
    } else if (outcome.hold) {
      S.held = [...S.held.filter((x) => x.task !== ev.task), ev];
      S.why = outcome.hold;
    } else S.why = `No notification. ${outcome.none}`;
    renderLayer();
    renderRail();
    if (S.sectionOpen && $("#settings-dialog").open) renderSettings();
  }

  // The rail goes on updating, notifications or not (section 6).
  function markRail(ev) {
    const { t } = findTask(ev.task);
    if (ev.kind === "approval" || ev.kind === "question") t.wait = ev.kind === "question" ? "question" : "approval";
    if (ev.kind === "finished") t.unread = true;
    if (ev.kind === "failed") t.status = "failed";
  }

  function quietEnds() {
    S.quietNow = false;
    const shown = [];
    for (const ev of S.held) {
      if (S.resolved.has(`${ev.task}:${ev.kind}`)) continue;
      const outcome = decide(ev);
      if (outcome.show) shown.push(outcome.show);
    }
    S.held = [];
    S.pics = [...shown, ...S.pics];
    S.why = shown.length ? "" : "Quiet hours ended. Nothing still waiting, so nothing was shown.";
    renderLayer();
    if ($("#settings-dialog").open) renderSettings();
  }

  function answeredElsewhere() {
    for (const ev of S.held) {
      S.resolved.add(`${ev.task}:${ev.kind}`);
      findTask(ev.task).t.wait = null;
    }
    S.why = "The wait was answered on another device.";
    renderLayer();
    renderRail();
  }

  // Opening (section 5) -------------------------------------------------------------------------------

  function open(pic) {
    S.pics = S.pics.filter((x) => x !== pic);
    S.why = "";
    const ev = pic.ev;
    setStrip(null);
    if (S.click === "othergw") {
      setStrip({ tone: "warn", text: "That notification came from Studio gateway. Clawtrate is using Home gateway now.", action: "Your gateways" });
      return renderLayer();
    }
    if (S.click === "stale") {
      S.why = "Clawtrate came forward as it was. It has no record of that notification, so nothing opened.";
      return renderLayer();
    }
    if (S.click === "gone") {
      S.sel = { bot: ev.bot, task: null };
      S.view = "detail";
      // The task list no longer has it: the rail drops it, as the reload does.
      const owner = bot(ev.bot);
      owner.tasks = owner.tasks.filter((x) => x.id !== ev.task);
      setStrip({ tone: "warn", text: "That task is no longer on the gateway." });
      renderLayer();
      render();
      return requestAnimationFrame(() => $(`.bot[data-bot="${ev.bot}"]`)?.focus());
    }
    if (S.click === "offline") setStrip({ tone: "warn", text: "Reconnecting in 4s", more: "showing saved messages" });
    S.sel = { bot: ev.bot, task: ev.task };
    S.view = "detail";
    S.opened = ev;
    if (ev.kind === "finished") findTask(ev.task).t.unread = false;
    renderLayer();
    render();
    requestAnimationFrame(() => {
      const target = $("#n-target");
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.focus();
      }
    });
  }

  function setStrip(strip) {
    S.strip = strip;
    const el = $("#status-strip");
    el.hidden = !strip;
    $(".conversation").dataset.strip = String(Boolean(strip));
    $("#gateway-dot").dataset.status = S.click === "offline" && strip ? "reconnecting" : "connected";
    $("#gateway-state").textContent = S.click === "offline" && strip ? "Reconnecting…" : "Connected";
    if (!strip) return;
    el.dataset.tone = strip.tone;
    el.innerHTML =
      `<span class="status-dot"></span><span class="status-strip-text">${esc(strip.text)}${strip.more ? `<span>· ${esc(strip.more)}</span>` : ""}</span>` +
      (strip.action ? `<button type="button" data-n="gateways">${strip.action}</button>` : "");
  }

  // The pictures ------------------------------------------------------------------------------------

  function renderLayer() {
    const layer = $("#n-layer");
    const pics = S.pics
      .map(
        (pic) =>
          `<div class="n-pic" data-testid="n-pic" data-kind="${pic.ev.kind}" data-bot="${pic.ev.bot}">` +
          `<p class="n-pic-label">Picture of a system notification</p>` +
          `<button type="button" class="n-pic-body" data-n-open="${esc(pic.id)}" aria-label="${esc(`${pic.title}. ${pic.body}${pic.preview ? " " + pic.preview : ""} Open.`)}">` +
          `<span class="n-pic-app"><img src="${LOGO}" alt="" width="16" height="16" />Clawtrate<span class="n-pic-when">now</span></span>` +
          `<span class="n-pic-title">${esc(pic.title)}</span><span class="n-pic-text">${esc(pic.body)}</span>` +
          (pic.preview ? `<span class="n-pic-preview">${esc(pic.preview)}</span>` : "") +
          `</button><button type="button" class="icon-button n-pic-close" data-n-close="${esc(pic.id)}" aria-label="Close the picture">${icon("x")}</button></div>`,
      )
      .join("");
    const why = S.why ? `<p class="n-why" data-testid="n-why" role="status"><span>Prototype: the host decided</span>${esc(S.why)}</p>` : "";
    layer.innerHTML = pics + why;
    CT.hydrate(layer);
  }

  // The shell -----------------------------------------------------------------------------------------

  const shell = $(".shell");

  function waitWords(t) {
    if (!t.wait) return "";
    if (S.device === "sender" || t.wait === "question") return t.wait === "question" ? "Waiting for you: a question" : "Waiting for you: approve a command";
    return "Waiting for an approval";
  }

  function renderRail() {
    const el = $("#bot-list");
    el.innerHTML = BOTS.map((b) => {
      const open = b.id === S.sel.bot;
      const waiting = b.tasks.find((t) => t.wait && !(t.wait === "question" && S.device === "read"));
      const latest = b.tasks[0];
      const preview = waiting ? waitWords(waiting) : latest.reply;
      const unread = b.tasks.some((t) => t.unread);
      const failed = b.tasks.some((t) => t.status === "failed");
      return (
        `<li class="bot-group"${open ? ' data-open="true"' : ""}>` +
        `<button type="button" class="bot" data-bot="${b.id}" aria-current="${open && !S.sel.task}" aria-expanded="${open}" data-testid="bot">` +
        `<span class="avatar" data-bot="${b.id}"></span>` +
        `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${latest.when}</time></span>` +
        `<span class="bot-line">${waiting ? glyph("waiting") : failed ? glyph("failed") : ""}<span class="bot-preview"${waiting ? ' data-tone="warn"' : ""}>${esc(preview)}</span>${unread ? '<span class="unread-dot"></span>' : ""}</span></span></button>` +
        (open
          ? `<ul class="task-list" aria-label="${b.name}'s tasks" data-testid="task-list">` +
            b.tasks
              .map((t) => {
                const current = S.sel.task === t.id;
                const mark = t.wait && !(t.wait === "question" && S.device === "read") ? glyph("waiting") : t.status === "failed" ? glyph("failed") : t.unread && !current ? '<span class="unread-dot" aria-hidden="true"></span>' : "";
                return `<li><button type="button" class="task" data-bot="${b.id}" data-task="${t.id}" aria-current="${current}" data-testid="task"><span class="task-title">${esc(t.title)}</span><time class="task-time">${t.when}</time>${mark}</button></li>`;
              })
              .join("") +
            `</ul>`
          : "") +
        `</li>`
      );
    }).join("");
    CT.hydrate(el);
  }

  function header() {
    const b = bot(S.sel.bot);
    const t = S.sel.task && findTask(S.sel.task).t;
    $("#title-pill").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><span class="title-pill-name">${b.name}</span>${t ? `<span class="title-pill-task">${esc(t.title)}</span>` : ""}`;
    CT.hydrate($("#title-pill"));
  }

  const turn = (role, html) => `<div class="turn" data-role="${role}">${html}</div>`;
  const user = (text) => turn("user", CT.msg({ role: "user", html: esc(text) }));

  function transcript() {
    const b = bot(S.sel.bot);
    const el = $("#transcript");
    if (!S.sel.task) {
      el.innerHTML =
        `<div class="empty"><div><span class="avatar" data-bot="${b.id}"></span><h1>Pick a task</h1><p>Choose one of ${b.name}'s tasks${S.access === "read" ? " to read the conversation" : ", or start a new one"}.</p></div></div>`;
      return CT.hydrate(el);
    }
    const { t } = findTask(S.sel.task);
    const ev = S.opened && S.opened.task === t.id ? S.opened : null;
    let body = `<div class="stamp">Today ${t.when}</div>`;
    if (t.from) body += `<p class="event-line" data-side="center">A message from ${bot(t.from).name}</p>`;
    if (t.ask) body += user(t.ask);
    if (ev?.kind === "approval") {
      if (S.device === "sender") {
        body += turn(
          "assistant",
          `<div id="n-target-wrap">` +
            CT.approval({
              id: "n-target",
              bot: "otto",
              summary: `List the size of each folder under <b>/var/lib</b> on the <b>media box</b>.`,
              full: { reason: "To find what fills the disk.", command: ev.command, fields: [["Runs on", "media-box"], ["Folder", "/var/lib"], ["Asked by", "Otto"]] },
              request: { command: ev.command, cwd: "/var/lib", host: "media-box", agentId: "otto" },
              raw: { events: [["exec.approval.requested, as the gateway sends it", '{ "id": "6af68f8a-…", "request": { "command": "du -sh /var/lib/transcode-cache" } }']], ids: [["Approval", "6af68f8a"]] },
            }) +
            `</div>`,
        );
        body += CT.statusLine({ bot: "otto", state: "waiting", phrase: "Waiting for you", elapsed: "0:12", badge: "waiting" });
      } else {
        const words =
          S.device === "read"
            ? `<p><b>Otto is waiting for an approval or an answer.</b> This device can't see it on a read-only connection.</p><p>${CT.linkButton("Request access")}</p>`
            : `<p><b>Otto is waiting for an approval.</b> This device can't answer it: the device that sent the message can.</p>`;
        body += `<div class="turn-note" id="n-target" tabindex="-1" data-testid="unseen-wait">${glyph("blocked")}<div>${words}</div></div>`;
        body += CT.statusLine({ bot: "otto", state: "thinking", badge: "blocked", phrase: "Waiting for an answer", elapsed: "0:12" });
      }
    } else if (ev?.kind === "question") {
      if (t.from) body += `<p class="request-asker n-asker">Marlow is working on a message from Pip.</p>`;
      body += turn(
        "assistant",
        CT.question({
          id: "n-target",
          bot: ev.bot,
          title: ev.question,
          options: ev.bot === "marlow" ? [["Yes, keep it free"], ["No, it can be used"]] : [["Running cost", "Over ten years"], ["Upfront price", "What I pay this year"]],
          raw: { events: [["question.requested, as the gateway sends it", '{ "id": "ask_ebb5ae55…", "status": "pending" }']], ids: [["Question", "ask_ebb5ae55"]] },
        }),
      );
    } else if (ev?.kind === "failed") {
      body += CT.turnError({ title: "Otto couldn't finish this turn", reason: "The model request failed. Nothing ran.", retry: S.access !== "read" }).replace('class="card turn-error"', 'class="card turn-error" id="n-target" tabindex="-1"');
    } else if (ev?.kind === "budget") {
      body += turn("assistant", CT.msg({ html: `<p>${esc(t.reply)}</p>` }));
      body += `<div class="event-line" data-side="center" id="n-target" tabindex="-1" data-testid="budget-line">Otto has used 82% of its weekly budget: 1.64M of 2M tokens.</div>`;
    } else {
      body += turn("assistant", CT.msg({ html: `<p>${esc(t.reply)}</p>`, id: ev?.kind === "finished" ? "n-target" : "" }).replace('id="n-target"', 'id="n-target" tabindex="-1"'));
    }
    el.innerHTML = `<div class="transcript-inner"><h1 class="task-line">${esc(t.title)}</h1>${body}</div>`;
    CT.hydrate(el);
  }

  function render() {
    shell.dataset.view = S.view;
    shell.dataset.panel = S.panel ? "open" : "closed";
    const button = $("#panel-button");
    button.setAttribute("aria-pressed", String(S.panel));
    button.setAttribute("aria-label", S.panel ? "Hide work panel" : "Show work panel");
    renderRail();
    header();
    transcript();
    renderPanel();
  }

  // The Work pane: Details (section 9) and the bot's Settings tab (section 8) -----------------------------

  const say = (where, text) => {
    const live = where === "pane" ? $("#pane-live") : $("#settings-live");
    if (live) {
      live.textContent = "";
      requestAnimationFrame(() => (live.textContent = text));
    }
  };
  const sw = (on, attrs, label, describedBy) =>
    `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}"${describedBy ? ` aria-describedby="${describedBy}"` : ""} ${attrs}></button>`;
  const switchRow = (id, title, sub, on, attrs, label) =>
    `<div class="b-row n-row" data-row="${id}"><span class="b-row-main"><span>${title}</span><small id="n-sub-${id}">${sub}</small></span>${sw(on, attrs, label, `n-sub-${id}`)}</div>`;
  const note = (html, tone = "") => `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${icon(tone ? "warning" : "approval")}<div>${html}</div></div>`;
  const accessBar = (need) => {
    if (S.req === "requested")
      return (
        `<section class="access-bar" role="region" aria-label="Access" data-state="requested"><div class="access-row">${glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span></div>` +
        `<div class="command-line"><code>openclaw devices approve 7c41d09e</code></div>` +
        `<div class="access-row"><span class="shelf-text">This changes by itself as soon as the owner approves or denies the request, or it expires.</span></div></section>`
      );
    return `<section class="access-bar" role="region" aria-label="Access" data-state="none"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> ${need}</span><button type="button" class="button" data-variant="primary" data-size="sm" data-n="request">Request access</button></div></section>`;
  };
  const NEED = "Changing quiet hours and your bots' notifications needs more access.";

  const taskValue = (taskId, botId) => {
    const own = S.tasks[taskId];
    if (own === "on") return "On";
    if (own === "off") return "Off";
    return `Same as ${bot(botId).name} (${S.bots[botId] ? "on" : "off"})`;
  };
  const botValue = (id) => (!S.master ? "Off on this computer" : S.bots[id] ? "On" : "Off");
  const savingLine = (key, idle) => (S.saving === key ? "Saving…" : S.error[key] || idle);

  function renderPanel() {
    const b = bot(S.sel.bot);
    const t = S.sel.task && findTask(S.sel.task).t;
    $("#work-hero").innerHTML = `<span class="avatar" data-bot="${b.id}"></span><h2>${b.name}</h2><p>${b.label}</p>`;
    CT.hydrate($("#work-hero"));
    const shared = canChangeShared();
    $("#panel-details").innerHTML = t
      ? `<p class="work-task">${esc(t.title)}</p>` +
        `<dl class="facts"><div><dt>Model</dt><dd>scripted/dev-1</dd></div><div><dt>Runs on</dt><dd>Gateway host</dd></div><div><dt>Last activity</dt><dd>Today, ${t.when}</dd></div></dl>` +
        `<h3 class="b-tabgroup">Notifications</h3>` +
        `<div class="n-select-row" data-testid="task-setting"><span class="n-select-label" id="n-task-label">This task</span>` +
        `<button type="button" class="b-select n-select" data-n="task-menu" aria-haspopup="menu" aria-expanded="false" aria-labelledby="n-task-label n-task-value"${shared && S.saving !== "task" ? "" : " disabled"}>` +
        `<span id="n-task-value">${S.saving === "task" ? "Saving…" : esc(taskValue(t.id, b.id))}</span>${icon("chevron")}</button></div>` +
        (S.error.task ? `<p class="b-field-error" data-testid="task-error">${S.error.task}</p>` : "") +
        (S.taskLimit
          ? `<p class="b-field-error" data-testid="task-limit">Up to 40 tasks can have their own setting. Set one back to "Same as" its bot first. <button type="button" class="link-button" data-n="bot-page">${b.name}'s notifications</button></p>`
          : "") +
        `<p class="b-hint">On or Off wins over ${b.name}'s switch. This computer's switch, focus and quiet hours still apply.</p>` +
        (S.access === "read" ? `<div class="b-panel-foot">${accessBar(NEED)}</div>` : "")
      : `<p class="work-note">No task is open. Pick one of ${b.name}'s tasks to see its details.</p>`;
    $("#panel-settings").innerHTML = S.bview === "notifications" ? botPage(b) : botFrame(b);
    CT.hydrate($("#panel-details"));
    CT.hydrate($("#panel-settings"));
    setTab(S.tab);
  }

  function setTab(name, focus = false) {
    S.tab = name;
    $$("[data-tab]").forEach((tab) => {
      const on = tab.dataset.tab === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    $$('.work-sections > [role="tabpanel"]').forEach((el) => (el.hidden = el.id !== `panel-${name}`));
  }

  // bots.md section 8's frame, with its one new row. The other rows are outlines here.
  function botFrame(b) {
    const row = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
    return (
      `<h3 class="b-tabgroup">About</h3><dl class="facts">${row("Description", '<span class="b-faint">None</span>')}${row("Instructions", "From AGENTS.md, 42 lines")}</dl>` +
      `<h3 class="b-tabgroup">Model</h3><dl class="facts">${row("Account", "OpenAI · Work")}</dl>` +
      `<h3 class="b-tabgroup">Tools</h3><dl class="facts">${row("Permissions", "Ask before running commands")}</dl>` +
      `<h3 class="b-tabgroup">Notifications</h3><dl class="facts"><div><button type="button" class="b-open" data-n="bot-page" data-testid="bot-notifications-row" aria-label="Notifications: ${esc(botValue(b.id))}. Open."><span>Notifications</span><span class="b-open-value">${esc(botValue(b.id))}</span>${icon("chevron")}</button></div></dl>` +
      `<h3 class="b-tabgroup">Runs on</h3><dl class="facts">${row("Machine", "Gateway host")}</dl>`
    );
  }

  function botPage(b) {
    const shared = canChangeShared();
    const own = b.tasks.filter((t) => S.tasks[t.id]);
    let html =
      `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-n="bot-back" aria-label="Back to settings">${icon("back")}</button><h3 tabindex="-1" data-n-focus>Notifications</h3></div>`;
    if (!S.master) html += note(`<p>Notifications are off on this computer.</p><div class="b-actions"><button type="button" class="link-button" data-n="settings">Settings</button></div>`);
    if (S.quietNow) html += note(`<p>Quiet until ${S.quiet.to}.</p>`);
    if (S.prefs === "reading") return html + `<div aria-busy="true" class="n-reading"><div class="skeleton" style="height:58px;width:100%"></div></div><p class="b-hint">Reading your settings from the gateway…</p>`;
    if (S.prefs === "readfail") return html + note(`<p>Couldn't read your notification settings from the gateway. Until Clawtrate can, it shows no notifications about your bots.</p><div class="b-actions"><button type="button" class="button" data-size="sm" data-n="retry-read">Try again</button></div>`, "danger");
    if (S.conflictNote) html += note(`<p>Changed on another of your devices a moment ago. This is what's set now.</p>`, "warn");
    html +=
      `<dl class="facts">` +
      switchRow(`bot-${b.id}`, `Notify me about ${b.name}`, savingLine(`bot-${b.id}`, `When ${b.name} finishes or waits for you.`), S.bots[b.id], `data-n-bot="${b.id}"${shared && S.saving !== `bot-${b.id}` ? "" : " disabled"}`, `${b.name}'s notifications`) +
      `</dl>` +
      `<h4 class="b-group">Tasks with their own setting</h4>` +
      (own.length
        ? `<dl class="facts">${own.map((t) => `<div><dt>${esc(t.title)}</dt><dd>${S.tasks[t.id] === "on" ? "On" : "Off"}</dd></div>`).join("")}</dl>`
        : `<p class="b-hint">No task has its own setting. Choose one in the task's Details.</p>`);
    if (S.access === "read") html += `<div class="b-panel-foot">${accessBar(NEED)}</div>`;
    return html;
  }

  // The task's menu (section 9).
  function openTaskMenu(button) {
    const t = findTask(S.sel.task).t;
    const b = bot(S.sel.bot);
    const current = S.tasks[t.id] || "same";
    const items = [["same", `Same as ${b.name} (${S.bots[b.id] ? "on" : "off"})`], ["on", "On"], ["off", "Off"]];
    const menu = $("#n-menu");
    menu.innerHTML = items
      .map(([v, label]) => `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${v === current}" data-n-task="${v}">${esc(label)}<span class="glyph" data-state="check"></span></button></li>`)
      .join("");
    const rect = button.getBoundingClientRect();
    const root = $("#root").getBoundingClientRect();
    menu.style.left = `${Math.max(8, rect.left - root.left)}px`;
    menu.style.top = `${rect.bottom - root.top + 4}px`;
    menu.style.minWidth = `${rect.width}px`;
    menu.hidden = false;
    button.setAttribute("aria-expanded", "true");
    menu.opener = button;
    $$("[data-n-task]", menu)[items.findIndex(([v]) => v === current)].focus();
  }
  function closeMenu(refocus = true) {
    const menu = $("#n-menu");
    if (menu.hidden) return;
    menu.hidden = true;
    menu.opener?.setAttribute("aria-expanded", "false");
    if (refocus) menu.opener?.focus();
  }

  // Saving your settings: written with a compare-and-set, then read back (section 2).
  function saveShared(key, apply, revertWords, doneWords, where) {
    S.saving = key;
    delete S.error[key];
    S.conflictNote = false;
    repaint(where);
    setTimeout(() => {
      S.saving = null;
      if (S.prefsFail === "savefail") {
        S.prefsFail = null;
        S.error[key] = `Couldn't save. ${revertWords}`;
        say(where, "Couldn't save");
      } else if (S.prefsFail === "conflict") {
        S.prefsFail = null;
        // Another device turned Pip off a moment before; that is what is read back.
        S.bots.pip = false;
        S.conflictNote = true;
        say(where, "Changed on another of your devices");
      } else {
        apply();
        repaint(where);
        say(where, doneWords());
        return;
      }
      repaint(where);
    }, 500);
  }
  function repaint(where) {
    if (where === "pane") renderPanel();
    else renderSettings();
    renderRail();
  }

  function chooseTask(value) {
    const t = findTask(S.sel.task).t;
    const b = bot(S.sel.bot);
    closeMenu(false);
    S.taskLimit = false;
    const count = Object.keys(S.tasks).length;
    if (value !== "same" && !S.tasks[t.id] && count >= 40) {
      S.taskLimit = true;
      renderPanel();
      return $('[data-n="task-menu"]').focus();
    }
    const before = taskValue(t.id, b.id);
    saveShared(
      "task",
      () => {
        if (value === "same") delete S.tasks[t.id];
        else S.tasks[t.id] = value;
      },
      `This task is still ${before}.`,
      () => `This task: ${taskValue(t.id, b.id)}`,
      "pane",
    );
    requestAnimationFrame(() => $('[data-n="task-menu"]')?.focus());
  }

  // Settings, Notifications (section 7) -----------------------------------------------------------------

  const SECTIONS = [
    ["gateway", "Gateway", "packages/ui/src/Settings.tsx, setup.md"],
    ["gateways", "Your gateways", "settings.md, in review"],
    ["accounts", "Accounts", "bots.md §7"],
    ["integrations", "Integrations", "bots.md §15"],
    ["permissions", "Permissions", "controls.md §7"],
    ["memory", "Memory", "controls.md §13"],
    ["usage", "Usage", "controls.md §16"],
    ["machines", "Machines", "controls.md §15"],
    ["appearance", "Appearance", "settings.md, in review"],
    ["notifications", "Notifications", ""],
    ["system", "System", "settings.md, in review"],
    ["updates", "Updates", "settings.md, in review"],
  ];
  const SYSTEM_NOTE = {
    mac: "Clawtrate shows notifications while it's open, also with its window closed. It can't see whether macOS allows them or whether a Focus is on.",
    windows: "Clawtrate shows notifications while it's open. Closing its window quits it. It can't see whether Windows allows them or whether Do Not Disturb is on.",
    linux: "Clawtrate shows notifications while it's open, and none while its window is focused.",
  };
  const minutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  const shift = (hhmm, h) => {
    const m = (minutes(hhmm) + h * 60 + 1440) % 1440;
    return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  };

  function openSettings(opener) {
    S.settingsOpener = opener || document.activeElement;
    S.sectionOpen = "notifications";
    S.settingsPane = "section";
    renderSettings();
    const dialog = $("#settings-dialog");
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => $("#b-section-title")?.focus());
  }

  function renderSettings() {
    const dialog = $("#settings-dialog");
    const active = document.activeElement;
    const activeKey = active && dialog.contains(active) ? active.dataset.n || active.dataset.nSet || active.dataset.nBot || active.id : null;
    const nav =
      `<nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2 id="settings-title">Settings</h2>${closeButton()}</div>` +
      SECTIONS.map(([id, label]) => `<button type="button" class="b-nav-item" data-n-section="${id}"${id === S.sectionOpen ? ' aria-current="page"' : ""}>${label}${icon("chevron")}</button>`).join("") +
      `</nav>`;
    const section = S.sectionOpen === "notifications" ? notificationsSection() : otherSection();
    // The live region stays put across repaints, so what it announces is not lost.
    if (!$("#settings-live", dialog)) dialog.innerHTML = `<div class="n-settings-body" id="settings-body"></div><p class="visually-hidden" id="settings-live" aria-live="polite"></p>`;
    const holder = $("#settings-body", dialog);
    const scroll = $(".b-section-body", holder)?.scrollTop || 0;
    holder.innerHTML =
      `<div class="b-settings" data-pane="${S.settingsPane}">${nav}<section class="b-section" aria-labelledby="b-section-title">${closeButton()}` +
      `<header class="b-section-head"><button type="button" class="icon-button b-back" data-variant="quiet" data-n="to-nav" data-b="to-nav" aria-label="Back to settings">${icon("back")}</button><h3 id="b-section-title" tabindex="-1">${section.title}</h3></header>` +
      `<div class="b-section-body">${section.body}</div>${section.foot ? `<footer class="b-section-foot">${section.foot}</footer>` : ""}</section></div>`;
    const body = $(".b-section-body", holder);
    if (body) body.scrollTop = scroll;
    CT.hydrate(holder);
    if (activeKey) {
      const again = $(`[data-n="${activeKey}"], [data-n-set="${activeKey}"], [data-n-bot="${activeKey}"], #${CSS.escape(activeKey)}`, dialog);
      again?.focus();
    }
  }
  const closeButton = () => `<button type="button" class="icon-button b-close" data-variant="quiet" data-n="settings-close" aria-label="Close settings">${icon("x")}</button>`;
  function otherSection() {
    const [, label, where] = SECTIONS.find(([id]) => id === S.sectionOpen);
    return { title: label, body: `<p class="b-hint">This section is designed in ${where}. This page draws only Notifications.</p>` };
  }

  function notificationsSection() {
    const shared = canChangeShared();
    const dis = (key) => (shared && S.saving !== key ? "" : " disabled");
    let body = "";
    if (S.failedAt) body += note(`<p>Your system didn't show Clawtrate's notification at ${S.failedAt}. Check Clawtrate in your system's notification settings.</p>`, "warn");
    body +=
      `<h4 class="b-group">This computer</h4><dl class="facts">` +
      switchRow("master", "Show notifications", savingLine("master", S.master ? "When a bot finishes or waits for you." : "No notifications on this computer. Your other devices keep theirs."), S.master, `data-n-set="master"${S.saving === "master" ? " disabled" : ""}`, "Show notifications") +
      switchRow("previews", "Show previews", savingLine("previews", "Adds a task's title and the first words of a reply, a command or a question. Anyone who can see your screen can read them, also when it's locked, unless your system hides previews."), S.previews, `data-n-set="previews"${S.saving === "previews" ? " disabled" : ""}`, "Show previews") +
      switchRow("budgetsw", "Budget warnings", savingLine("budgetsw", "When a bot has used 80% of a budget."), S.budgetsw, `data-n-set="budgetsw"${S.saving === "budgetsw" ? " disabled" : ""}`, "Budget warnings") +
      `</dl>` +
      `<p class="b-hint" data-testid="system-note">${SYSTEM_NOTE[S.os]}</p>`;
    if (S.conflictNote) body += note(`<p>Changed on another of your devices a moment ago. This is what's set now.</p>`, "warn");
    body += `<h4 class="b-group">Quiet hours</h4>`;
    if (S.prefs === "reading") body += `<div aria-busy="true" class="n-reading"><div class="skeleton" style="height:58px;width:100%"></div><div class="skeleton" style="height:120px;width:100%"></div></div><p class="b-hint" data-testid="reading">Reading your settings from the gateway…</p>`;
    else if (S.prefs === "readfail")
      body += note(`<p>Couldn't read your notification settings from the gateway. Until Clawtrate can, it shows no notifications about your bots.</p><div class="b-actions"><button type="button" class="button" data-size="sm" data-n="retry-read">Try again</button></div>`, "danger");
    else {
      body +=
        `<dl class="facts">` +
        switchRow("quiet", "Quiet hours", savingLine("quiet", "Nothing is shown during them. A bot still waiting for you when they end is shown then."), S.quiet.enabled, `data-n-set="quiet"${dis("quiet")}`, "Quiet hours") +
        `</dl>`;
      if (S.quiet.enabled) {
        const elsewhere = S.prefs === "elsewhere";
        body +=
          `<div class="n-times" data-testid="quiet-times">` +
          `<label class="n-time"><small>From</small><input type="time" value="${S.quiet.from}" data-n-time="from" aria-label="Quiet hours from"${shared ? "" : " disabled"}${S.timeError ? ' aria-invalid="true" aria-describedby="n-time-error"' : ""} /></label>` +
          `<label class="n-time"><small>To</small><input type="time" value="${S.quiet.to}" data-n-time="to" aria-label="Quiet hours to"${shared ? "" : " disabled"}${S.timeError ? ' aria-invalid="true" aria-describedby="n-time-error"' : ""} /></label></div>` +
          (S.timeError ? `<p class="b-field-error" id="n-time-error" data-testid="time-error">Start and end can't be the same time.</p>` : "") +
          `<p class="b-hint" data-testid="zone-line">${
            elsewhere
              ? `${S.quiet.from} to ${S.quiet.to}, Lisbon time, where they were set. That's ${shift(S.quiet.from, 1)} to ${shift(S.quiet.to, 1)} here. Saving here sets them in Berlin time.`
              : `${S.quiet.from} to ${S.quiet.to}, Lisbon time. Set on this computer.`
          }</p>` +
          (S.quietNow
            ? `<p class="n-now" data-testid="quiet-now">Quiet until ${S.quiet.to}.${S.held.length ? ` ${S.held.length} bot${S.held.length === 1 ? " is" : "s are"} waiting for you. ${S.held.length === 1 ? "It" : "They"} will be shown then.` : ""}</p>`
            : "");
      }
      body +=
        `<h4 class="b-group">Your bots</h4><dl class="facts">` +
        BOTS.map((b) => {
          const own = b.tasks.filter((t) => S.tasks[t.id] && S.tasks[t.id] !== (S.bots[b.id] ? "on" : "off")).length;
          const line = `${S.bots[b.id] ? "On" : "Off"}${own ? ` · ${own} task${own === 1 ? "" : "s"} ${S.bots[b.id] ? "off" : "on"}` : ""}`;
          return switchRow(`bot-${b.id}`, `<span class="n-botname"><span class="avatar" data-bot="${b.id}"></span>${b.name}</span>`, savingLine(`bot-${b.id}`, line), S.bots[b.id], `data-n-bot="${b.id}"${dis(`bot-${b.id}`)}`, `${b.name}'s notifications`);
        }).join("") +
        `</dl>` +
        `<p class="b-hint" data-testid="kept-line">${
          S.prefs === "device"
            ? "This gateway can't keep these for your other devices, so Clawtrate keeps quiet hours and your bots' settings on this computer."
            : "Quiet hours and your bots' settings are kept with your profile on the gateway, so your other devices use them too. The switches under This computer are this computer's."
        }</p>`;
    }
    const foot = S.access === "read" ? accessBar(NEED) : "";
    return { title: "Notifications", body, foot };
  }

  function toggleDevice(key) {
    const names = { master: "Notifications on this computer are", previews: "Previews are", budgetsw: "Budget warnings are" };
    S.saving = key;
    renderSettings();
    setTimeout(() => {
      S.saving = null;
      S[key] = !S[key];
      renderSettings();
      renderPanel();
      say("settings", key === "previews" ? (S.previews ? "Previews are shown" : "Previews are hidden") : `${names[key]} ${S[key] ? "on" : "off"}`);
    }, 300);
  }

  function toggleQuiet() {
    const next = !S.quiet.enabled;
    saveShared(
      "quiet",
      () => (S.quiet.enabled = next),
      `Quiet hours are still ${S.quiet.enabled ? "on" : "off"}.`,
      () => (S.quiet.enabled ? `Quiet hours are on, ${S.quiet.from} to ${S.quiet.to}` : "Quiet hours are off"),
      "settings",
    );
  }

  function toggleBot(id, where) {
    const b = bot(id);
    const next = !S.bots[id];
    saveShared(`bot-${id}`, () => (S.bots[id] = next), `${b.name}'s notifications are still ${S.bots[id] ? "on" : "off"}.`, () => `${b.name}'s notifications are ${S.bots[id] ? "on" : "off"}`, where);
  }

  function setTime(which, value) {
    const other = which === "from" ? S.quiet.to : S.quiet.from;
    if (value === other) {
      S.timeError = true;
      renderSettings();
      return;
    }
    S.timeError = false;
    saveShared("quiet", () => (S.quiet[which] = value), "Quiet hours are as they were.", () => `Quiet hours are on, ${S.quiet.from} to ${S.quiet.to}`, "settings");
  }

  // The prototype's bar -----------------------------------------------------------------------------------

  function bar() {
    const extra = $("#proto-extra");
    if (!extra) return;
    const opt = (v, l, cur) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`;
    extra.innerHTML =
      `<span class="run-controls n-bar">` +
      `<label>This device <select data-bar="device">${opt("sender", "sent the message", S.device)}${opt("other", "another device", S.device)}${opt("read", "read-only", S.device)}</select></label>` +
      `<label>Event <select data-bar="event">${Object.entries(EVENTS).map(([k, e]) => opt(k, e.label, "finished")).join("")}</select></label>` +
      `<button type="button" data-bar="fire">Happens</button>` +
      `<label>Focus <select data-bar="focus">${opt("", "none", S.focus || "")}${opt("otto", "Otto on screen", S.focus || "")}${opt("pip", "Pip on screen", S.focus || "")}</select></label>` +
      `<button type="button" data-bar="quiet" aria-pressed="${S.quietNow}">Quiet hours now</button>` +
      `<button type="button" data-bar="answered">Answered elsewhere</button>` +
      `<button type="button" data-bar="quietend">Quiet hours end</button>` +
      `<label>At the click <select data-bar="click">${opt("", "all well", S.click)}${opt("gone", "task deleted", S.click)}${opt("offline", "connection down", S.click)}${opt("othergw", "another gateway", S.click)}${opt("stale", "no record", S.click)}</select></label>` +
      `<button type="button" data-bar="settings">Settings</button>` +
      `</span>`;
    extra.addEventListener("change", (event) => {
      const el = event.target;
      if (el.dataset.bar === "device") (S.device = el.value), render();
      if (el.dataset.bar === "focus") S.focus = el.value || null;
      if (el.dataset.bar === "click") S.click = el.value;
    });
    extra.addEventListener("click", (event) => {
      const el = event.target.closest("[data-bar]");
      if (!el) return;
      if (el.dataset.bar === "fire") fire($('[data-bar="event"]', extra).value);
      if (el.dataset.bar === "quiet") {
        S.quietNow = !S.quietNow;
        if (S.quietNow) S.quiet.enabled = true;
        el.setAttribute("aria-pressed", String(S.quietNow));
      }
      if (el.dataset.bar === "quietend") quietEnds();
      if (el.dataset.bar === "answered") answeredElsewhere();
      if (el.dataset.bar === "settings") openSettings(el);
    });
  }

  // Events ----------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const t = event.target;
    const openPic = t.closest("[data-n-open]");
    if (openPic) return open(S.pics.find((x) => x.id === openPic.dataset.nOpen));
    const closePic = t.closest("[data-n-close]");
    if (closePic) {
      S.pics = S.pics.filter((x) => x.id !== closePic.dataset.nClose);
      return renderLayer();
    }
    if (!t.closest("#n-menu") && !t.closest('[data-n="task-menu"]')) closeMenu(false);
    const botRow = t.closest(".bot[data-bot]");
    if (botRow) {
      S.sel = { bot: botRow.dataset.bot, task: S.sel.bot === botRow.dataset.bot ? S.sel.task : null };
      S.bview = "main";
      return render();
    }
    const taskRow = t.closest(".task[data-task]");
    if (taskRow) {
      S.sel = { bot: taskRow.dataset.bot, task: taskRow.dataset.task };
      S.opened = null;
      findTask(taskRow.dataset.task).t.unread = false;
      // Opening a task withdraws its notification (section 3).
      S.pics = S.pics.filter((x) => x.ev.task !== taskRow.dataset.task);
      renderLayer();
      return render();
    }
    const tab = t.closest("[data-tab]");
    if (tab) return setTab(tab.dataset.tab, true);
    const section = t.closest("[data-n-section]");
    if (section) {
      S.sectionOpen = section.dataset.nSection;
      S.settingsPane = "section";
      renderSettings();
      return $("#b-section-title")?.focus();
    }
    const setBtn = t.closest("[data-n-set]");
    if (setBtn && !setBtn.disabled) return setBtn.dataset.nSet === "quiet" ? toggleQuiet() : toggleDevice(setBtn.dataset.nSet);
    const botSw = t.closest("[data-n-bot]");
    if (botSw && !botSw.disabled) return toggleBot(botSw.dataset.nBot, botSw.closest("#settings-dialog") ? "settings" : "pane");
    const taskChoice = t.closest("[data-n-task]");
    if (taskChoice) return chooseTask(taskChoice.dataset.nTask);
    const n = t.closest("[data-n]")?.dataset.n;
    if (!n) return;
    if (n === "settings") return openSettings(t.closest("[data-n]"));
    if (n === "settings-close") {
      $("#settings-dialog").close();
      return S.settingsOpener?.focus();
    }
    if (n === "to-nav") {
      S.settingsPane = "nav";
      renderSettings();
      return $(`[data-n-section="${S.sectionOpen}"]`)?.focus();
    }
    if (n === "panel") {
      S.panel = !S.panel;
      return render();
    }
    if (n === "panel-close") {
      S.panel = false;
      return render();
    }
    if (n === "back") {
      S.view = "list";
      return render();
    }
    if (n === "bot-page") {
      S.panel = true;
      S.tab = "settings";
      S.bview = "notifications";
      render();
      return requestAnimationFrame(() => $("[data-n-focus]")?.focus());
    }
    if (n === "bot-back") {
      S.bview = "main";
      renderPanel();
      return $('[data-n="bot-page"]')?.focus();
    }
    if (n === "task-menu") return $("#n-menu").hidden ? openTaskMenu(t.closest("[data-n]")) : closeMenu();
    if (n === "request") {
      S.req = "requested";
      renderSettings();
      return renderPanel();
    }
    if (n === "retry-read") {
      S.prefs = "ok";
      renderSettings();
      return renderPanel();
    }
    if (n === "gateways") {
      openSettings(t);
      S.sectionOpen = "gateways";
      return renderSettings();
    }
  });

  document.addEventListener("change", (event) => {
    const el = event.target.closest("[data-n-time]");
    if (el) setTime(el.dataset.nTime, el.value);
  });

  document.addEventListener("keydown", (event) => {
    const menu = $("#n-menu");
    if (!menu.hidden) {
      const items = $$("[data-n-task]", menu);
      const i = items.indexOf(document.activeElement);
      if (event.key === "ArrowDown") items[(i + 1) % items.length].focus(), event.preventDefault();
      if (event.key === "ArrowUp") items[(i - 1 + items.length) % items.length].focus(), event.preventDefault();
      if (event.key === "Escape") closeMenu(), event.preventDefault();
    }
    if ((event.metaKey || event.ctrlKey) && event.key === ",") {
      event.preventDefault();
      openSettings();
    }
  });

  // First paint -----------------------------------------------------------------------------------------

  const first = p("open");
  if (S.focus) S.sel = { bot: S.focus, task: bot(S.focus).tasks[0].id };
  render();
  renderLayer();
  // The prototype's bar is filled at DOMContentLoaded by prototype.js, whose listener comes first.
  document.addEventListener("DOMContentLoaded", bar);
  if (p("event")) fire(p("event"));
  if (first === "settings") openSettings();
  if (first === "bot") {
    S.panel = true;
    S.tab = "settings";
    S.bview = "notifications";
    render();
  }
  if (first === "details") {
    S.sel = { bot: "otto", task: "o3" };
    S.panel = true;
    S.tab = "details";
    render();
  }
  window.notif = { S, fire, decide, open, quietEnds };
})();
