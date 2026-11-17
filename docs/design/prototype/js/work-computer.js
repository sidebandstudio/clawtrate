// Part 3 of the Work pane: the computer. The Computer tab, the machine, watching
// a bot's browser, taking control and handing it back, and every state where
// that is not available. It plugs into work.js through CT.work.
// docs/design/work-pane.md, sections 15 to 19.
//
// States from the address:
//   ?bot=juniper&task=j2&panel=open&tab=computer
//   ?computer=noplugin|unconfigured|unused|closed|watching|full|draining|control|
//             busy|conflict|ended|offline|stuck|active
//   ?firstwatch=1        the one-time note before the first watch
//   ?state=readonly      a read-only connection

(function () {
  const CT = window.CT;
  const W = CT.work;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = CT.esc;
  const icon = (name, cls) => CT.icon(name, cls);
  const glyph = (state) => `<span class="glyph" data-state="${state}" aria-hidden="true"></span>`;
  const mode = params.get("computer") || "";
  const NOW = "3:12 PM";

  // Juniper's browser: its tabs and a page drawn here. The site is invented.
  const tabs = [
    { id: "t1", title: "Your account", domain: "library.example", site: "Riverbend Library" },
    { id: "t2", title: "Lending apps", domain: "shelfwise.example", site: "Shelfwise" },
  ];
  const C = {
    plugin: mode !== "noplugin",
    configured: mode !== "unconfigured",
    used: mode !== "unused",
    open: mode !== "closed",
    view: ["watching", "full", "draining", "control", "busy", "conflict", "stuck", "releasefail", "releaseunknown", "complexquestion"].includes(mode) ? "live" : mode === "ended" ? "ended" : "idle",
    full: ["full", "draining", "control", "busy", "conflict", "releasefail", "releaseunknown", "complexquestion"].includes(mode),
    control: { draining: "draining", control: "granted", busy: "busy", conflict: "conflict", stuck: "busy", releasefail: "granted", releaseunknown: "granted", complexquestion: "granted" }[mode] || "none",
    busyCount: mode === "stuck" ? 3 : 0,
    tab: "t1",
    noteSeen: params.get("firstwatch") !== "1",
    showLive: false,
    question: mode !== "active",
    active: mode === "active",
    typed: "",
    events: mode === "control" ? [`You took control of Juniper's browser · ${NOW}`] : [],
    nodeOffline: mode === "offline",
    stopped: false,
    viewSession: 0,
    elsewhere: mode === "elsewhere", // another device holds control: every reader sees the gateway's control event
    takeSession: 0,
    disposed: [],
    lateReleased: 0,
    outcome: "",
  };
  let lastTask = null;

  const readOnly = () => W.app?.model.access === "read" || window.app?.model.access === "read";
  const app = () => window.app;

  // The page in the bot's browser, as frames would show it.
  function page(tab = C.tab) {
    const t = tabs.find((x) => x.id === tab);
    if (t.id === "t2") {
      return (
        `<svg viewBox="0 0 1280 720" role="img" aria-label="A page listing e-book lending apps">` +
        `<rect width="1280" height="720" fill="#ffffff"/><rect width="1280" height="72" fill="#1f3b2c"/>` +
        `<text x="48" y="46" font-family="Figtree Variable, sans-serif" font-size="26" font-weight="600" fill="#ffffff">Shelfwise</text>` +
        [0, 1, 2].map((i) => `<rect x="48" y="${120 + i * 170}" width="1184" height="140" rx="16" fill="#f0f0ee"/><rect x="80" y="${150 + i * 170}" width="${380 - i * 60}" height="22" rx="6" fill="#c9cbc6"/><rect x="80" y="${190 + i * 170}" width="620" height="14" rx="6" fill="#dedfdb"/>`).join("") +
        `</svg>`
      );
    }
    const typed = C.typed ? esc(C.typed) : "";
    return (
      `<svg viewBox="0 0 1280 720" role="img" aria-label="Riverbend Library's sign-in page">` +
      `<rect width="1280" height="720" fill="#f7f5f0"/><rect width="1280" height="80" fill="#24425f"/>` +
      `<text x="48" y="50" font-family="Figtree Variable, sans-serif" font-size="28" font-weight="600" fill="#ffffff">Riverbend Library</text>` +
      `<text x="900" y="50" font-family="Figtree Variable, sans-serif" font-size="18" fill="#cfd8e3">Catalog   Events   Account</text>` +
      `<rect x="440" y="150" width="400" height="430" rx="18" fill="#ffffff" stroke="#e1ddd3"/>` +
      `<text x="480" y="210" font-family="Figtree Variable, sans-serif" font-size="26" font-weight="600" fill="#1d1f22">Sign in to your account</text>` +
      `<text x="480" y="262" font-family="Figtree Variable, sans-serif" font-size="16" fill="#55575b">Library card number</text>` +
      `<rect x="480" y="274" width="320" height="48" rx="10" fill="#ffffff" stroke="${C.typed ? "#24425f" : "#c8c3b6"}" stroke-width="2"/>` +
      `<text x="496" y="305" font-family="JetBrains Mono Variable, monospace" font-size="18" fill="#1d1f22">${typed}</text>` +
      `<text x="480" y="356" font-family="Figtree Variable, sans-serif" font-size="16" fill="#55575b">PIN</text>` +
      `<rect x="480" y="368" width="320" height="48" rx="10" fill="#ffffff" stroke="#c8c3b6" stroke-width="2"/>` +
      `<rect x="480" y="448" width="320" height="52" rx="26" fill="#24425f"/>` +
      `<text x="606" y="481" font-family="Figtree Variable, sans-serif" font-size="18" font-weight="600" fill="#ffffff">Sign in</text>` +
      `<g class="screen-pointer"><path d="M640 300 l0 26 l7 -7 l6 13 l5 -2 l-6 -13 l10 0 z" fill="#111213" stroke="#ffffff" stroke-width="2"/></g>` +
      `</svg>`
    );
  }

  // The Computer tab ------------------------------------------------------------------------------

  const section = (title, html) => (html ? `<section class="work-section computer-section"><h3>${title}</h3>${html}</section>` : "");
  const tabNow = () => tabs.find((x) => x.id === C.tab);

  function screenSection(b, t) {
    const name = b.name;
    if (!C.plugin) {
      return (
        `<div class="work-empty computer-empty"><span class="empty-mark">${icon("plugin")}</span><h4>Watching isn't set up on this gateway</h4>` +
        `<p>To watch ${name}'s browser here, the gateway's owner installs Clawtrate's computer plugin and gives ${name} a browser of its own.</p>` +
        `${CT.linkButton("What the plugin adds", { icon: "external", attrs: 'data-cmp="docs"' })}</div>` +
        `<p class="computer-shared">Without it, nothing here gives ${name} a browser of its own. By default, bots that use the browser share one profile, with its sign-ins.</p>`
      );
    }
    if (!C.configured) {
      return (
        `<div class="work-empty computer-empty"><span class="empty-mark">${icon("screen")}</span><h4>${name} has no browser of its own yet</h4>` +
        `<p>The gateway's owner adds ${name} to the computer plugin's list of bots. Until then ${name}'s browser can't be watched here.</p></div>` +
        `<p class="computer-shared">Nothing here gives ${name} a browser of its own. By default, bots that use the browser share one profile, with its sign-ins.</p>`
      );
    }
    if (!C.used) {
      return `<div class="work-empty"><span class="empty-mark">${icon("screen")}</span><h4>No screen to show</h4><p>When ${name} uses its browser, you can watch it here.</p></div>`;
    }
    if (readOnly()) {
      return (
        `<div class="screen" data-theme="dark" data-state="blocked"><div class="screen-blank">${icon("eye")}<p>Watching needs a connection that can send. This device is read-only.</p>` +
        `<button type="button" class="button" data-size="sm" data-cmp="request">Request access</button></div></div>` +
        (C.elsewhere ? `<p class="screen-caption">Someone on another device has control of ${name}'s browser.</p>` : "")
      );
    }
    if (!C.open) {
      return `<div class="screen" data-theme="dark" data-state="closed"><div class="screen-blank">${icon("screen")}<p>${name}'s browser has no tabs open. If ${name} opens one, it appears here.</p></div></div>`;
    }
    const tab = tabNow();
    const note =
      !C.noteSeen && C.view === "idle"
        ? `<p class="files-alert" data-tone="quiet" role="note">This is ${name}'s browser, used by all of ${name}'s tasks. It may be signed in to sites, and what you see here is live: anyone who can see your screen sees it too.` +
          `<button type="button" class="button" data-size="sm" data-cmp="note-ok">Got it</button></p>`
        : "";
    let tile;
    if (C.view === "live") {
      tile =
        `<div class="screen" data-theme="dark" data-state="live" role="img" aria-label="${name}'s browser, live: ${esc(tab.title)}">${page()}` +
        `<span class="screen-live">Live</span>` +
        `<span class="screen-actions"><button type="button" class="icon-button" data-cmp="open" aria-label="Open ${name}'s browser full window" title="Open">${icon("expand")}</button>` +
        `<button type="button" class="icon-button" data-cmp="stop" aria-label="Stop watching" title="Stop watching">${icon("x")}</button></span></div>`;
    } else if (C.view === "connecting") {
      tile = `<div class="screen" data-theme="dark" data-state="connecting" aria-busy="true"><div class="screen-blank">${glyph("working")}<p>Connecting to ${name}'s browser…</p></div></div>`;
    } else if (C.view === "ended" || C.view === "closed-tab" || C.view === "dropped") {
      const words =
        C.view === "closed-tab" ? `${name} closed this tab.` : C.view === "dropped" ? "The view ended when the connection dropped." : "The view ended. The gateway stopped sending it.";
      tile =
        `<div class="screen" data-theme="dark" data-state="ended"><div class="screen-blank"><p>${words}</p>` +
        `<button type="button" class="screen-watch" data-cmp="watch">${icon("eye")}Watch again</button></div></div>`;
    } else {
      tile =
        `<div class="screen" data-theme="dark" data-state="idle"><div class="screen-blank">${icon("screen")}` +
        `<button type="button" class="screen-watch" data-cmp="watch" aria-label="Watch ${name}'s browser">${icon("eye")}Watch</button></div></div>`;
    }
    return (
      note +
      tile +
      `<p class="screen-caption">${name}'s browser, used by all of its tasks<br><span>${esc(tab.title)} · ${tab.domain}</span></p>` +
      (C.control === "granted" && !C.full ? `<p class="screen-caption"><strong>You have control.</strong> ${CT.linkButton("Give back control", { attrs: 'data-cmp="release"' })}</p>` : "") +
      (tabs.length > 1
        ? `<ul class="screen-tabs" aria-label="${name}'s tabs">${tabs
            .map((x) => `<li><button type="button" class="screen-tab" data-cmp-tab="${x.id}" aria-current="${x.id === C.tab}"><span>${esc(x.title)}</span><span>${x.domain}</span></button></li>`)
            .join("")}</ul>`
        : "") +
      `<label class="screen-auto"><input type="checkbox" data-cmp="auto"${C.showLive ? " checked" : ""}> Show live when I open Computer</label>`
    );
  }

  // Control this device may still hold, out of sight: after leaving with the release
  // unconfirmed, or after a drop. It is shown until a confirmation or an end is observed.
  function heldLine(b) {
    const name = b.name;
    if (C.full) return "";
    if (C.outOfSight && ["releasing", "unconfirmed"].includes(C.control))
      return (
        `<p class="files-alert computer-held" role="alert">This device may still have control of ${name}'s browser. Giving it back wasn't confirmed; it ends by itself within about 20 seconds.` +
        `<button type="button" class="button" data-size="sm" data-cmp="release">Give it back</button></p>`
      );
    if (C.control === "maybeheld")
      return `<p class="files-alert computer-held" role="alert">The connection dropped. Control of ${name}'s browser may remain with this device until it expires.</p>`;
    if (C.control === "checking") return `<p class="files-alert computer-held" data-tone="quiet" role="status">${glyph("working")}Checking ${name}'s question and browser…</p>`;
    if (C.control === "ended" && !viewing())
      return `<p class="files-alert computer-held" data-tone="quiet" role="status">Your control ended.${C.endCause ? ` ${C.endCause}` : ""}</p>`;
    return "";
  }

  function banner(b) {
    if (!C.plugin || !C.configured || !C.used || !C.open || !C.question || readOnly() || C.stopped) return "";
    if (["maybeheld", "checking", "releasing", "unconfirmed"].includes(C.control)) return "";
    const waiting = C.released ? `${b.name} is still waiting for you` : `${b.name} is waiting for you`;
    return (
      `<div class="computer-banner" role="region" aria-label="${waiting}">${glyph("waiting")}<div><strong>${waiting}</strong>` +
      `<p>Sign in to your library account, then hand the browser back.</p><div class="computer-banner-actions">` +
      `<button type="button" class="button" data-size="sm" data-variant="primary" data-cmp="take">${icon("hand")}Take control</button>` +
      `<button type="button" class="button" data-size="sm" data-cmp="show-question">Show the question</button></div></div></div>`
    );
  }

  // Where the task's work runs: only what the gateway established (work-pane.md, section 16).
  function machine(b) {
    const name = b.name;
    const row = (k, v, sub = "") => `<div><dt>${k}</dt><dd>${v}${sub ? `<span class="machine-sub">${sub}</span>` : ""}</dd></div>`;
    const browser = C.plugin && C.configured && b.id === "juniper" ? `The gateway's machine, in ${name}'s own browser` : "Not reported.";
    if (b.id === "otto") {
      const off = C.nodeOffline;
      const unknown = mode === "nodeunknown";
      const state = unknown
        ? `${glyph("queued")}Unknown<span class="machine-sub">Connected when last read, 5:38 PM. Couldn't read it again.</span>`
        : off
          ? `${glyph("failed")}Not connected`
          : `${glyph("done")}Connected`;
      return (
        (off
          ? `<p class="files-alert" role="alert">media-box isn't connected to the gateway. Nodes reconnect by themselves when they can; check that it's on and online.` +
            `<button type="button" class="button" data-size="sm" data-cmp="check">${C.checking ? "Checking…" : "Check again"}</button>` +
            (C.checked ? `<span class="machine-sub">Checked ${C.checked}</span>` : "") +
            `</p>`
          : "") +
        `<dl class="facts">` +
        // An approval names a proposed target; only a command's own result says where it ran.
        row("Command approval target", "media-box", "Requested 5:31 PM · allowed") +
        row("Commands ran on", "media-box", "By the command at 5:36 PM, from its result") +
        row(`Set for ${name}`, "Commands: media-box", `A setting for ${name}. A task can run somewhere else.`) +
        row("Browser", browser) +
        `</dl>` +
        `<p class="machine-name">${icon("machine")}media-box</p>` +
        `<dl class="facts">` +
        `<div><dt>State</dt><dd class="machine-state">${state}</dd></div>` +
        row("Last seen", off ? "5:12 PM, while going to sleep" : "40 s ago") +
        (off || unknown ? "" : row("Load", "4 cores, 0.6 average") + row("Memory", "3.1 of 8 GB free") + row("Disk", "780 GB of 2 TB free")) +
        `</dl>` +
        (off || unknown ? "" : `<p class="machine-asof">As of 5:40 PM</p>`) +
        `<p class="machine-foot"><span>Pip is also set to run commands here.</span>${CT.linkButton("Node settings", { attrs: 'data-cmp="node-settings"' })}</p>`
      );
    }
    return (
      `<dl class="facts">` +
      row("Command approval target", "Not reported in this task.") +
      row(`Set for ${name}`, "Commands: the gateway's machine", `A setting for ${name}. A task can run somewhere else.`) +
      row("Browser", browser) +
      `</dl>`
    );
  }

  const actionRow = (time, kind, title, step, trigger = "") =>
    `<li><button type="button" class="action-row" data-show-step="${step}" aria-label="${esc(`${title}, ${time}${trigger ? `, ${trigger}` : ""}. Show in chat`)}">` +
    `<time>${time}</time>${icon(kind === "web" ? "web" : kind === "command" ? "command" : "read")}<span>${esc(title)}</span>${trigger ? `<em>${esc(trigger)}</em>` : ""}</button></li>`;

  function actions(b, t) {
    if (t.id === "j2") {
      return (
        `<ul class="action-list">` +
        (C.active ? actionRow("3:12 PM", "web", "Opening shelfwise.example", "st-web-3") : "") +
        actionRow("3:11 PM", "web", "Typed in the search box", "st-web-2") +
        actionRow("3:10 PM", "web", "Opened library.example/account", "st-web-1") +
        `</ul>`
      );
    }
    if (t.id === "o1") {
      return `<ul class="action-list">${actionRow("5:37 PM", "command", "Ran python3", "st-chart")}${actionRow("5:36 PM", "command", "Ran mv", "st-mv")}${actionRow("5:31 PM", "command", "Ran du", "st-du")}</ul>`;
    }
    return "";
  }

  function commands(b, t) {
    if (t.id !== "o1") return "";
    const row = (cmd, end, took, step) =>
      `<li class="command-row"><code>${esc(cmd)}</code><span>${end} · ${took}</span>${CT.linkButton("Show in chat", { tone: "muted", attrs: `data-show-step="${step}"`, name: `Show ${cmd} in the chat` })}</li>`;
    return `<ul class="command-list">${row("python3 tools/disk_chart.py --out charts/usage.png", "exit 0", "2.1s", "st-chart")}${row("mv /var/lib/transcode-cache /var/lib/transcode-cache.old", "exit 0", "0.4s", "st-mv")}${row("du -sh /var/lib/*", "exit 0", "6.2s", "st-du")}</ul>`;
  }

  function stuckLine(b) {
    if (C.busyCount < 3) return "";
    if (C.stopped) return `<p class="files-alert" data-tone="quiet" role="status">Stopped ${b.name}'s runs in this task. Its other tasks and other bots keep going.</p>`;
    return (
      `<p class="files-alert" role="alert">${b.name}'s browser has been busy for a while. A call that never finished can keep control from being handed over. If stopping doesn't free it, the gateway's owner can restart the gateway.` +
      `<button type="button" class="button" data-size="sm" data-cmp="stop-task">Stop ${b.name} in this task</button></p>`
    );
  }

  W.renderComputer = (b, t) => {
    const el = $("#panel-computer");
    if (!el) return;
    if (!t) {
      el.innerHTML = `<p class="work-note">Pick one of ${b.name}'s tasks to see its computer.</p>`;
      return;
    }
    // A view ends when the task or bot changes.
    if (lastTask && lastTask !== t.id && viewing()) endView("idle");
    lastTask = t.id;
    const isJ = t.id === "j2";
    // Only Juniper's research task has used a browser in these fixtures.
    const screen = isJ
      ? screenSection(b, t)
      : `<div class="work-empty"><span class="empty-mark">${icon("screen")}</span><h4>No screen to show</h4><p>When ${b.name} uses its browser, you can watch it here.</p></div>`;
    el.innerHTML =
      `<div class="computer">` +
      (isJ ? heldLine(b) + banner(b) + stuckLine(b) : "") +
      section("Screen", screen) +
      section("Machine", machine(b)) +
      section("Recent actions", actions(b, t)) +
      section("Commands", commands(b, t)) +
      `</div>`;
    CT.hydrate(el);
  };

  // The header's computer button and the tab's mark (F-139).
  W.header = (b, t) => {
    const button = $("#computer-button");
    if (!button) return;
    const used = t?.id === "j2" && C.used;
    button.hidden = !used;
    button.dataset.active = String(Boolean(used && C.active));
    button.setAttribute("aria-label", `${b.name}'s computer${C.active ? ", in use" : ""}. Show the computer`);
    button.title = "Computer";
    const tab = $("#tab-computer");
    if (tab) tab.innerHTML = `Computer${used && C.active ? '<span class="tab-mark" aria-hidden="true"></span>' : ""}`;
    if (tab) tab.setAttribute("aria-label", used && C.active ? "Computer, in use" : "Computer");
    CT.fitTabs?.();
  };

  // Watching -------------------------------------------------------------------------------------------

  const rerenderComputer = () => {
    const b = W.currentBot();
    const t = W.current();
    if (b) W.renderComputer(b, t);
    if (b) W.header(b, t);
    if (C.full) renderFull();
  };

  // A view from start to end (work-pane.md, section 17): every Watch has its own
  // number, and an answer for a view that has ended is disposed of, not shown.
  function watch() {
    if (readOnly()) return;
    C.noteSeen = true;
    const id = ++C.viewSession;
    C.view = "connecting";
    rerenderComputer();
    setTimeout(() => {
      if (id !== C.viewSession || C.view !== "connecting") {
        C.disposed.push("ticket"); // the ticket arrives late: never used, the stream never opened
        return;
      }
      C.view = "live";
      rerenderComputer();
      $('[data-cmp="open"]')?.focus();
    }, 500);
  }

  // Anything that ends a view: control is given back first, a pending take is
  // abandoned, and the view's number moves on so late answers are dropped.
  function endView(to = "idle") {
    if (C.control === "draining") abandonTake();
    if (C.control === "granted") giveBack({ leaving: true });
    if (["releasing", "unconfirmed"].includes(C.control)) {
      C.outOfSight = true; // the frames go now; the lease stops being renewed and expires by itself
      C.renewing = false;
    }
    C.viewSession++;
    C.view = to;
    if (C.full) closeFull(false);
  }
  const viewing = () => C.view === "live" || C.view === "connecting";

  // The full view.
  let fullOpener = null;
  function openFull() {
    fullOpener = document.activeElement;
    C.full = true;
    renderFull();
    ($('[data-cmp="take"]', $(".screen-view")) || $('[data-cmp="close-full"]', $(".screen-view")))?.focus();
  }
  function closeFull(refocus = true) {
    C.full = false;
    $(".screen-view")?.remove();
    $(".shell").inert = false;
    if (refocus) {
      rerenderComputer();
      ($('[data-cmp="open"]') || fullOpener)?.focus();
    }
  }

  // Which questions the bar can answer: one question, one answer, two to four options.
  const simpleQuestion = () => C.question && mode !== "complexquestion";

  function controlBar(b) {
    const name = b.name;
    const bar = (state, html, role = "status") => `<div class="control-bar"${state ? ` data-state="${state}"` : ""} role="${role}">${html}</div>`;
    const btn = (label, cmp, variant = "", extra = "") => `<button type="button" class="button" data-size="sm"${variant ? ` data-variant="${variant}"` : ""} data-cmp="${cmp}" ${extra}>${label}</button>`;
    if (C.control === "draining") return bar("", `${glyph("working")}<span>Waiting for ${name} to finish what it's doing in the browser…</span><span class="spacer"></span>${btn("Cancel", "cancel-take")}`);
    if (C.control === "busy") return bar("", `<span>${name} is still acting in this browser. Try again in a moment.</span><span class="spacer"></span>${btn("Try again", "take")}`, "alert");
    if (C.control === "conflict") return bar("", `<span>Someone on another device has control of ${name}'s browser.</span>`);
    const why = C.dropped ? `<span class="control-gone">${C.dropped}</span>` : "";
    if (C.control === "ended") return bar("", `<span>Your control ended.${C.endCause ? ` ${C.endCause}` : ""}</span>${why}<span class="spacer"></span>${btn("Take control", "take")}`, "alert");
    if (C.control === "releasing") return bar("", `${glyph("working")}<span>Giving control back…</span>${why}`);
    if (C.control === "unconfirmed")
      return bar(
        "unconfirmed",
        `<span>Giving control back wasn't confirmed. This device may still have control of ${name}'s browser.</span>${why}<span class="spacer"></span>${btn("Try again", "release")}${btn("Check", "check-release")}`,
        "alert",
      );
    if (C.control === "answering") return bar("", `${glyph("working")}<span>Sending your answer…</span>`);
    if (C.outcome) return bar("", `<span>${C.outcome}</span>${C.outcomeAction ? `<span class="spacer"></span>${btn("Show the question", "show-question")}` : ""}`, "status");
    if (C.control !== "granted") return "";
    let answers = "";
    if (simpleQuestion()) answers = ["I'm done", "Skip"].map((label, i) => btn(label, "answer", i === 0 ? "primary" : "", `data-answer="${i}"`)).join("");
    else if (C.question) answers = btn("Give back control and answer", "answer-in-chat", "primary");
    const gone = C.questionGone ? `<span class="control-gone">${C.questionGone}</span>` : "";
    return (
      bar("control", `${icon("hand")}<strong>You have control</strong>${gone}<span class="spacer"></span>${answers}${btn("Give back control", "release", C.question ? "quiet" : "primary")}`) +
      (C.notice ? `<p class="control-note" role="status">${C.notice}</p>` : "") +
      `<p class="control-note" id="control-note">Clicks, scrolling and typed text reach the page; Enter, Tab and other keys don't yet. Until you give control back, ${name}'s browser tool can't act here, in any of ${name}'s tasks. Other ways in aren't blocked: the gateway's own browser controls, and other tools such as commands, can still reach this browser. Pages you open aren't checked by the gateway's browser rules.</p>`
    );
  }

  function renderFull() {
    // A read-only connection never receives the view: no full view, no control.
    if (readOnly()) {
      C.full = false;
      C.control = "none";
      $(".screen-view")?.remove();
      $(".shell").inert = false;
      return;
    }
    const b = window.app.bots.find((x) => x.id === "juniper");
    let view = $(".screen-view");
    const focusKey = document.activeElement?.dataset?.cmp;
    if (!view) {
      view = document.createElement("div");
      view.className = "screen-view";
      view.dataset.theme = "dark";
      view.setAttribute("role", "dialog");
      view.setAttribute("aria-modal", "true");
      $(".app").appendChild(view);
      $(".shell").inert = true;
    }
    const tab = tabNow();
    const control = C.control === "granted";
    view.setAttribute("aria-label", `${b.name}'s browser`);
    if ($(".app").clientWidth < 688) return renderPhone(view, b, tab, control, focusKey);
    delete view.dataset.layout;
    view.innerHTML =
      `<div class="viewer-bar screen-bar"><span class="avatar" data-bot="juniper"></span><div class="viewer-title"><strong>${b.name}'s browser</strong>` +
      `<span>${esc(tab.title)} · ${tab.domain}</span>${holding() ? "" : `<span class="screen-mode">Watching</span>`}</div>` +
      (holding() || readOnly() ? "" : `<button type="button" class="button" data-size="sm" data-cmp="take">${icon("hand")}Take control</button>`) +
      `<button type="button" class="icon-button" data-cmp="close-full" aria-label="Close the full view (Esc)" title="Close (Esc)">${icon("collapse")}</button></div>` +
      controlBar(b) +
      `<div class="screen-pills" role="group" aria-label="Tabs">${tabs.map((x) => `<button type="button" class="screen-pill" data-cmp-tab="${x.id}" aria-pressed="${x.id === C.tab}">${esc(x.title)}</button>`).join("")}</div>` +
      `<div class="screen-stage"><div class="screen-frame" data-control="${control}" tabindex="0" role="application" aria-label="${b.name}'s browser, live${control ? ", you have control" : ""}"${control ? ' aria-describedby="control-note"' : ""}>${page()}` +
      `<span class="screen-hint" role="status" hidden></span></div></div>`;
    CT.hydrate(view);
    if (focusKey) $(`[data-cmp="${focusKey}"]`, view)?.focus();
  }

  // Until the gateway confirms the release, the lease may still be held: the bar
  // never says "Watching" or offers Take control while control is asked for,
  // held, being given back, or uncertain.
  const holding = () => ["draining", "granted", "releasing", "unconfirmed"].includes(C.control);

  // The phone's full view (work-pane.md, section 18, "On the phone"): the page
  // zooms and pans on the device; in control it opens at the page's own size.
  const PAGE_WIDTH = 1280;
  function zoomLevels(fit) {
    return [fit, fit * 2, PAGE_WIDTH, fit * 4].sort((x, y) => x - y);
  }
  function renderPhone(view, b, tab, control, focusKey) {
    view.dataset.layout = "phone";
    const zoomBox = $(".screen-zoom", view);
    const keep = zoomBox ? { left: zoomBox.scrollLeft, top: zoomBox.scrollTop } : null;
    const fit = Math.max(200, $(".app").clientWidth - 16);
    const levels = zoomLevels(fit);
    if (C.zoomFor !== (control ? "control" : "watch")) {
      // Watching opens fitted; control opens at the page's own size, centred where the last action was.
      C.zoomFor = control ? "control" : "watch";
      C.zoom = control ? levels.indexOf(PAGE_WIDTH) : 0;
      C.centre = true;
    }
    const width = levels[C.zoom];
    const dock =
      control || ["draining", "releasing", "unconfirmed", "answering", "busy", "conflict", "ended"].includes(C.control) || C.outcome
        ? controlBar(b)
        : readOnly()
          ? ""
          : `<div class="control-bar"><button type="button" class="button" data-variant="primary" data-cmp="take">${icon("hand")}Take control</button></div>`;
    view.innerHTML =
      `<div class="viewer-bar screen-bar"><span class="avatar" data-bot="juniper"></span><div class="viewer-title"><strong aria-label="${b.name}'s browser">${b.name}</strong>` +
      `<span class="screen-mode">${control ? "You have control" : holding() ? "Control" : "Watching"}</span></div>` +
      (tabs.length > 1 ? `<button type="button" class="screen-pill" data-cmp="tabs-sheet" aria-expanded="${Boolean(C.tabsOpen)}" aria-label="${tabs.length} tabs, showing ${esc(tab.title)}">${tabs.length} tabs</button>` : "") +
      `<button type="button" class="icon-button" data-cmp="close-full" aria-label="Close the full view" title="Close">${icon("collapse")}</button></div>` +
      (C.tabsOpen
        ? `<ul class="menu screen-tabs-sheet" role="menu" aria-label="Tabs">${tabs.map((x) => `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${x.id === C.tab}" data-cmp-tab="${x.id}">${esc(x.title)}<span>${x.domain}</span></button></li>`).join("")}</ul>`
        : "") +
      `<div class="screen-stage"><div class="screen-zoom" data-level="${C.zoom}">` +
      `<div class="screen-frame" data-control="${control}" tabindex="0" role="application" style="width:${width}px" aria-label="${b.name}'s browser, live${control ? ", you have control" : ""}">${page()}` +
      `<span class="screen-hint" role="status" hidden></span></div></div>` +
      `<div class="zoom-controls" role="group" aria-label="Zoom"><button type="button" class="icon-button" data-cmp="zoom-out" aria-label="Zoom out"${C.zoom === 0 ? " disabled" : ""}>${icon("minus")}</button>` +
      `<button type="button" class="zoom-fit" data-cmp="zoom-fit" aria-label="Fit the page to the screen">Fit</button>` +
      `<button type="button" class="icon-button" data-cmp="zoom-in" aria-label="Zoom in"${C.zoom === levels.length - 1 ? " disabled" : ""}>${icon("plus")}</button></div>` +
      (control ? `<button type="button" class="icon-button keyboard-button" data-cmp="keyboard" aria-label="Type into the page" aria-expanded="${Boolean(C.typing)}">${icon("keyboard")}</button>` : "") +
      `</div>` +
      (control
        ? `<details class="control-help"><summary>What reaches the page</summary><p>Clicks, scrolling and typed text reach the page; Enter, Tab and other keys don't yet. Until you give control back, ${b.name}'s browser tool can't act here, in any of ${b.name}'s tasks. Other ways in aren't blocked: the gateway's own browser controls, and other tools such as commands, can still reach this browser. Pages you open aren't checked by the gateway's browser rules.</p></details>`
        : "") +
      `<div class="control-dock">${dock}</div>` +
      (control && C.typing
        ? `<div class="type-bar"><label class="visually-hidden" for="type-input">Type into the page</label><input class="input" id="type-input" type="text" autocomplete="off" autocapitalize="off" placeholder="Type into the page" value="${esc(C.typedNow || "")}"><button type="button" class="button" data-size="sm" data-cmp="type-done">Done</button></div>`
        : "");
    CT.hydrate(view);
    const box = $(".screen-zoom", view);
    if (C.centre) {
      // Centre on the last place acted on: the sign-in field, at (640, 300) of the page.
      const scale = width / PAGE_WIDTH;
      box.scrollLeft = Math.max(0, 640 * scale - box.clientWidth / 2);
      box.scrollTop = Math.max(0, 300 * scale - box.clientHeight / 2);
      C.centre = false;
    } else if (keep) {
      box.scrollLeft = keep.left;
      box.scrollTop = keep.top;
    }
    if (focusKey) $(`[data-cmp="${focusKey}"]`, view)?.focus();
    if (C.typing) $("#type-input", view)?.focus();
  }

  // Taking control. The gateway answers a take once, up to 15 s later, and has no
  // way to withdraw it; an answer to an abandoned request is disposed of.
  function take() {
    if (readOnly()) return;
    if (!C.full) openFull();
    const id = ++C.takeSession;
    C.control = "draining";
    C.outcome = "";
    renderFull();
    $('[data-cmp="cancel-take"]')?.focus();
    setTimeout(() => arrive(id), 900);
  }
  function abandonTake() {
    C.takeSession++;
    C.control = "none";
  }
  function arrive(id) {
    const result = mode === "busy" || mode === "stuck" ? "busy" : mode === "conflict" ? "conflict" : "granted";
    if (id !== C.takeSession || C.control !== "draining") {
      // Abandoned: a late grant is given back at once, with nothing shown but the
      // gateway's own record in the conversation.
      if (result === "granted") {
        C.lateReleased += 1;
        eventLine(`You took control of Juniper's browser · ${NOW}`);
        eventLine(`You gave control back · ${NOW}`);
      }
      return;
    }
    if (result === "busy") {
      C.control = "busy";
      C.busyCount += 1;
    } else if (result === "conflict") C.control = "conflict";
    else {
      C.control = "granted";
      C.events.push(`You took control of Juniper's browser · ${NOW}`);
      eventLine(`You took control of Juniper's browser · ${NOW}`);
      CT.announce("You have control of Juniper's browser");
    }
    rerenderComputer();
    ($('[data-cmp="answer"]') || $('[data-cmp="answer-in-chat"]') || $('[data-cmp="release"]') || $('[data-cmp="take"]'))?.focus();
  }

  // Handing back, in order (work-pane.md, section 18): control first; an answer
  // queued behind it goes only on the release call's own success result (or a
  // released event with this lease's generation). The whole sequence has a
  // number, and a lost connection retires it.
  let sequence = 0;
  function giveBack({ leaving = false, queued = null } = {}) {
    const my = ++sequence;
    C.control = "releasing";
    C.queued = queued;
    C.dropped = "";
    C.notice = "";
    C.outcome = "";
    if (!leaving) rerenderComputer();
    // The fixture's gateway: refused, no answer, or success.
    const outcome = mode === "releasefail" && !C.retried ? "refused" : mode === "releaseunknown" && !C.retried ? "noanswer" : "ok";
    setTimeout(() => releaseResult(my, outcome), 400);
  }
  function releaseResult(my, outcome) {
    if (my !== sequence) return; // retired: nothing is assumed, nothing queued is sent
    if (outcome !== "ok") {
      // A refusal or a missing answer is not proof of ownership: unconfirmed, input stopped.
      C.control = "unconfirmed";
      if (C.queued) C.dropped = "Your answer wasn't sent. Answer in the chat once control is given back.";
      C.queued = null;
      rerenderComputer();
      if (!C.outOfSight) $('[data-cmp="check-release"]')?.focus();
      return;
    }
    // Confirmed by the device's own release call.
    C.control = "none";
    C.outOfSight = false;
    C.released = C.question;
    eventLine(`You gave control back · 3:14 PM`);
    CT.announce("Control given back to Juniper");
    const queued = C.queued;
    C.queued = null;
    if (C.dropped) {
      C.outcome = C.dropped;
      C.dropped = "";
    }
    if (queued?.chat) {
      closeFull(false);
      rerenderComputer();
      const card = $("#q-library");
      if (card) W.reveal(card, card);
      return;
    }
    if (queued && "i" in queued) return sendAnswer(my, queued.i);
    rerenderComputer();
    ($('[data-cmp="take"]', $(".screen-view") || document) || $('[data-cmp="close-full"]'))?.focus();
  }
  function sendAnswer(my, i) {
    if (!C.question) return rerenderComputer(); // the question closed meanwhile: nothing is sent
    C.control = "answering";
    rerenderComputer();
    setTimeout(() => {
      if (my !== sequence) return;
      C.control = "none";
      if (!C.question) {
        C.outcome = C.closedWhy || "Juniper's question was already answered on another device.";
      } else if (mode === "answerfail") {
        C.outcome = "Couldn't send your answer. Control is back with Juniper; answer in the chat.";
        C.outcomeAction = true;
      } else {
        const option = $$(".option", $("#q-library") || document)[i];
        C.question = false;
        option?.click(); // the question card answers as it always does
        C.outcome = "Answer sent. Juniper can carry on.";
        CT.announce("Answer sent, and control given back to Juniper");
      }
      rerenderComputer();
      $('[data-cmp="close-full"]')?.focus();
    }, 400);
  }
  function release() {
    C.retried = C.control === "unconfirmed" || C.outOfSight;
    giveBack({ leaving: !viewing() });
  }
  function answer(i) {
    giveBack({ queued: { i } });
  }
  // The question closes, or the run ends, while an answer waits behind the release.
  function questionClosed(why, runEnded = false) {
    C.question = false;
    C.closedWhy = why;
    C.questionGone = runEnded ? "" : why.replace(", so your answer wasn't sent", "");
    if (C.queued && "i" in C.queued) {
      C.queued = null;
      C.dropped = why;
    }
    rerenderComputer();
  }

  function eventLine(text) {
    const inner = $("#transcript .transcript-inner");
    if (!inner) return;
    inner.insertAdjacentHTML("beforeend", `<div class="event-line" data-side="center">${esc(text)}</div>`);
  }

  // Juniper's research task gains a run that uses the browser and waits on the person.
  const prevExtend = W.extendFixtures;
  W.extendFixtures = (bots) => {
    prevExtend?.(bots);
    const j2 = bots.find((b) => b.id === "juniper").tasks.find((t) => t.id === "j2");
    j2.status = "running";
    j2.when = "now";
    const step = (id, title, detail, status = "done", took = "1.2s") =>
      CT.step({
        id,
        kind: "web",
        status,
        title,
        detail,
        statusText: status === "running" ? "" : took,
        body: CT.stepBody({ readable: CT.fields([["Address", "https://library.example/account", { mono: true }]]), raw: { tool: "browser", args: '{\n  "action": "open",\n  "url": "https://library.example/account"\n}', result: "Opened tab t1.", ids: [["Tool call", `call_${id}`]] } }),
      });
    j2.html +=
      CT.stamp("Today 3:10 PM") +
      W.turn("user", W.bubble("user", "Check whether my holds are ready.")) +
      W.turn(
        "assistant",
        CT.activity({
          id: "act-j3",
          state: "running",
          label: C.active ? "Working" : "Waiting for you",
          count: C.active ? "3 steps" : "2 steps",
          steps:
            step("st-web-1", "Opened library.example", "Your account") +
            step("st-web-2", "Typed in the search box", "1 field") +
            (C.active ? step("st-web-3", "Opening shelfwise.example", "", "running") : ""),
        }) +
          (C.active
            ? ""
            : CT.question({
                id: "q-library",
                bot: "juniper",
                title: "Sign in to your library account, then hand the browser back.",
                options: [["I'm done", "I signed in. Carry on."], ["Skip", "Check the holds another way."]],
                raw: CT.samples?.questionRaw?.() || { events: [["Question", "{}"]], ids: [["Question", "q_7d1"]] },
              })),
      ) +
      C.events.map((e) => `<div class="event-line" data-side="center">${esc(e)}</div>`).join("");
  };

  // Wiring ---------------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const t = event.target;
    const tabButton = t.closest("[data-cmp-tab]");
    if (tabButton) {
      C.tabsOpen = false;
      C.tab = tabButton.dataset.cmpTab;
      C.typed = "";
      rerenderComputer();
      return $(`[data-cmp-tab="${C.tab}"]`, C.full ? $(".screen-view") : document)?.focus();
    }
    if (t.closest('[data-action="computer"]')) {
      window.app.setPanel(true);
      window.app.setTab("computer");
      return $("#tab-computer").focus();
    }
    const frame = t.closest(".screen-frame");
    if (frame && C.control === "granted") {
      const r = frame.getBoundingClientRect();
      const dot = document.createElement("span");
      dot.className = "screen-click";
      dot.style.left = `${event.clientX - r.left}px`;
      dot.style.top = `${event.clientY - r.top}px`;
      frame.appendChild(dot);
      setTimeout(() => dot.remove(), 500);
      return;
    }
    const cmp = t.closest("[data-cmp]")?.dataset.cmp;
    if (!cmp) return;
    if (cmp === "watch") return watch();
    if (cmp === "stop") {
      endView("idle");
      rerenderComputer();
      return $('[data-cmp="watch"]')?.focus();
    }
    if (cmp === "open") return openFull();
    if (cmp === "close-full") return closeFull();
    if (cmp === "take") {
      if (readOnly()) return;
      if (C.view !== "live") {
        C.viewSession++;
        C.view = "live";
      }
      return take();
    }
    if (cmp === "cancel-take") {
      abandonTake();
      rerenderComputer();
      return $('[data-cmp="take"]')?.focus();
    }
    if (cmp === "release") return release();
    if (cmp === "zoom-in" || cmp === "zoom-out" || cmp === "zoom-fit") {
      const levels = zoomLevels(Math.max(200, $(".app").clientWidth - 16));
      C.zoom = cmp === "zoom-fit" ? 0 : Math.max(0, Math.min(levels.length - 1, C.zoom + (cmp === "zoom-in" ? 1 : -1)));
      renderFull();
      return $(`[data-cmp="${cmp}"]`, $(".screen-view"))?.focus();
    }
    if (cmp === "keyboard") {
      C.typing = !C.typing;
      C.typedNow = "";
      return renderFull();
    }
    if (cmp === "type-done") {
      C.typing = false;
      C.typedNow = ""; // the field clears when it closes, and is never stored
      renderFull();
      return $('[data-cmp="keyboard"]', $(".screen-view"))?.focus();
    }
    if (cmp === "tabs-sheet") {
      C.tabsOpen = !C.tabsOpen;
      renderFull();
      return C.tabsOpen ? $(".screen-tabs-sheet .menu-item", $(".screen-view"))?.focus() : null;
    }
    if (cmp === "check-release") {
      // Renew with the generation: renewed is evidence it is still held; not renewed, that it ended.
      if (mode === "releasefail") {
        C.control = "granted";
        C.notice = "You still have control.";
      } else {
        C.control = "ended";
        C.endCause = ""; // a renewal that was not renewed reports no cause
        C.outOfSight = false;
      }
      rerenderComputer();
      return ($('[data-cmp="release"]') || $('[data-cmp="take"]'))?.focus();
    }
    if (cmp === "answer-in-chat") return giveBack({ queued: { chat: true } });
    if (cmp === "answer") return answer(+t.closest("[data-answer]").dataset.answer);
    if (cmp === "show-question") {
      const card = $("#q-library");
      if (card) W.reveal(card, card);
      return;
    }
    if (cmp === "note-ok") {
      C.noteSeen = true;
      rerenderComputer();
      return $('[data-cmp="watch"]')?.focus();
    }
    if (cmp === "auto") return (C.showLive = t.checked);
    if (cmp === "check") {
      C.checking = true;
      rerenderComputer();
      return setTimeout(() => {
        C.checking = false;
        rerenderComputer();
        C.checked = "5:42 PM";
        rerenderComputer();
        CT.announce("media-box is still not connected");
      }, 700);
    }
    if (cmp === "stop-task") return confirmStop(t.closest("button"));
    if (cmp === "confirm-stop") {
      C.stopped = true;
      C.control = "none";
      $(".stop-confirm")?.remove();
      rerenderComputer();
      return CT.announce("Stopped Juniper's runs in this task");
    }
    if (cmp === "cancel-stop") {
      $(".stop-confirm")?.remove();
      return $('[data-cmp="stop-task"]')?.focus();
    }
    if (cmp === "request") return CT.toast("This starts the conversation's request for access. conversation.html shows it.");
    if (cmp === "docs") return CT.toast("Opens the plugin's page in the project's documentation.");
    if (cmp === "node-settings") return CT.toast("Opens Settings at media-box. That screen is not part of this design.");
  });

  function confirmStop(opener) {
    $(".stop-confirm")?.remove();
    const box = document.createElement("div");
    box.className = "menu stop-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-label", "Stop Juniper in this task?");
    box.innerHTML =
      `<p><strong>Stop Juniper's runs in this task?</strong> Steps already done stay done. Juniper's other tasks and other bots keep going.</p>` +
      `<div class="stop-actions"><button type="button" class="button" data-size="sm" data-cmp="cancel-stop">Cancel</button><button type="button" class="button" data-size="sm" data-tone="danger" data-cmp="confirm-stop">Stop</button></div>`;
    opener.closest(".files-alert").after(box);
    $('[data-cmp="cancel-stop"]', box).focus();
  }

  document.addEventListener("input", (event) => {
    if (event.target.id !== "type-input" || C.control !== "granted") return;
    const value = event.target.value;
    const added = value.slice((C.typedNow || "").length);
    C.typed += added; // sent as text, as it is typed
    C.typedNow = value;
    const frame = $(".screen-view .screen-frame svg");
    if (frame) frame.outerHTML = page();
  });

  document.addEventListener(
    "keydown",
    (event) => {
      const view = $(".screen-view");
      if (view && event.target.id === "type-input" && event.key === "Enter") {
        event.preventDefault();
        const hint = $(".screen-hint", view);
        hint.textContent = "Enter isn't sent to the page. Tap the page's button instead.";
        hint.hidden = false;
        clearTimeout(hint._t);
        hint._t = setTimeout(() => (hint.hidden = true), 3000);
        return;
      }
      if (!view) return;
      const inFrame = event.target.closest?.(".screen-frame");
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        // In control, Escape never hands back and is never sent to the page: it moves to Give back control.
        if (C.control === "granted") return $('[data-cmp="release"]', view)?.focus();
        return closeFull();
      }
      if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
        event.preventDefault();
        return ($('[data-variant="primary"][data-cmp]', view) || $('[data-cmp="take"]', view))?.click();
      }
      if (inFrame && C.control === "granted") {
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey) {
          event.preventDefault();
          C.typed += event.key;
          $(".screen-frame svg", view).outerHTML = page();
          return;
        }
        if (["Enter", "Backspace"].includes(event.key)) {
          event.preventDefault();
          const hint = $(".screen-hint", view);
          hint.textContent = `${event.key} isn't sent to the page. ${event.key === "Enter" ? "Click the page's button instead." : ""}`.trim();
          hint.hidden = false;
          clearTimeout(hint._t);
          hint._t = setTimeout(() => (hint.hidden = true), 3000);
          return;
        }
      }
      if (event.key === "Tab") {
        const items = $$("button, [tabindex='0']", view).filter((x) => !x.closest("[hidden]"));
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
    },
    true,
  );

  // Leaving: the view stops when it is no longer in front of the person.
  const prevTab = W.tabChanged;
  W.tabChanged = (name) => {
    prevTab?.(name);
    if (name !== "computer" && viewing() && !C.full) {
      endView("idle");
      rerenderComputer();
    } else if (name === "computer" && C.showLive && C.view === "idle" && W.current()?.id === "j2") watch();
  };
  const prevPanel = W.panelChanged;
  W.panelChanged = (open) => {
    prevPanel?.(open);
    if (!open && viewing() && !C.full) {
      endView("idle");
      setTimeout(rerenderComputer);
    }
  };
  W.connectionChanged = (name) => {
    const lost = name !== "connected" && name !== "synced" && name !== "syncing";
    if (lost) {
      if (["granted", "releasing", "unconfirmed", "answering"].includes(C.control)) {
        sequence++; // every queued step is retired: no result assumed, no queued answer sent later
        C.queued = null;
        C.dropped = "";
        C.control = "maybeheld";
        C.outOfSight = false;
      }
      if (viewing()) endView("dropped");
      rerenderComputer();
    } else if (C.control === "maybeheld") {
      // Read the question's and the browser's state again before offering anything.
      C.control = "checking";
      rerenderComputer();
      setTimeout(() => {
        C.control = "ended"; // the fixture's tab list shows no lease for this device
        C.endCause = "";
        rerenderComputer();
      }, 500);
    }
  };
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && viewing()) {
      endView("idle");
      rerenderComputer();
    }
  });

  // Controls in the prototype's bar.
  W.barExtra = (W.barExtra || "") + `<button type="button" data-work="tab-closed">Juniper closes its tab</button><button type="button" data-work="lease-ends">The lease ends</button><button type="button" data-work="answered-elsewhere">Answered elsewhere</button><button type="button" data-work="run-ends">Juniper's run ends</button>`;
  const prevBar = W.bar;
  W.bar = (what) => {
    if (prevBar?.(what)) return true;
    if (what === "tab-closed") {
      if (C.full) closeFull(false);
      C.control = "none";
      C.view = "closed-tab";
      rerenderComputer();
      return true;
    }
    if (what === "lease-ends") {
      // An expired control event carrying this lease's generation.
      if (["granted", "unconfirmed", "releasing"].includes(C.control)) {
        sequence++;
        C.queued = null;
        C.control = "ended";
        C.endCause = "It expired.";
        C.outOfSight = false;
        eventLine("Your control of Juniper's browser ended · 3:14 PM");
        rerenderComputer();
      }
      return true;
    }
    if (what === "answered-elsewhere") {
      questionClosed("Juniper's question was answered on another device, so your answer wasn't sent.");
      return true;
    }
    if (what === "run-ends") {
      questionClosed("Juniper's run ended, so your answer wasn't sent.", true);
      return true;
    }
    return false;
  };

  const prevReady = W.ready;
  W.ready = (a) => {
    prevReady?.(a);
    // A read-only connection never receives the view, whatever the address asks for.
    if (readOnly()) {
      C.full = false;
      C.control = "none";
      C.view = "idle";
    }
    if (C.full) setTimeout(() => renderFull());
  };

  W.computer = C;
})();
