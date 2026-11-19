// settings.html: what docs/design/settings.md adds on top of controls.html.
// Several gateways (the gateway menu, Your gateways, adding, switching,
// removing), Appearance, System and Updates in Settings, Update required,
// Compact in the Work pane's Details tab with its line in the transcript, and
// the low-disk note. Every gateway, figure and reply is a local fixture.
//
// It is loaded before app.js, because app.js reads CT.appExtension when it
// starts; everything that needs bots.js runs at DOMContentLoaded, after every
// deferred script.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);

  // Fixtures -------------------------------------------------------------------------------------

  const DEVICE = "9c2e41d07a3b5f18";
  const GW = {
    home: { id: "home", name: "Home gateway", route: "gateway.local", kind: "address", last: "Today, 5:41 PM", identity: "2a47552309d7", drafts: 0 },
    studio: { id: "studio", name: "Studio gateway", route: "devbox, over SSH", kind: "ssh", last: "Nov 18, 4:02 PM", identity: "7be0c914a2f1", drafts: 2, access: "Read-only" },
    lab: { id: "lab", name: "Lab gateway", route: "198.51.100.7", kind: "address", last: "Just now", identity: "c41d9a06e7b3", drafts: 0, access: "Read-only" },
    noid: { id: "noid", name: "198.51.100.7", route: "198.51.100.7", kind: "address", last: "Just now", identity: null, drafts: 0, access: "Read-only" },
  };
  const task = (id, title, at, when, preview, extra = {}) => ({ id, title, at, when, preview, unread: false, status: "idle", ...extra });
  // Each gateway's own bots. Bots, tasks and transcripts are in memory only, so a switch loads them again.
  const BOTS = {
    studio: () => [
      { id: "marlow", name: "Marlow", label: "Writing", tasks: [task("sm1", "Grant report outline", 1030, "5:10 PM", "Here is the outline, five sections.", { ask: "Outline the grant report." })] },
      { id: "pip", name: "Pip", label: "Planning", tasks: [task("sp1", "Studio move checklist", 990, "4:30 PM", "Twelve things, in the order they need doing.", { ask: "What do I need to do before the studio move?" })] },
    ],
    lab: () => [{ id: "juniper", name: "Juniper", label: "Research", tasks: [task("lj1", "Sensor calibration notes", 1000, "4:40 PM", "The drift is within the spec.", { ask: "Is the drift within spec?" })] }],
    noid: () => [{ id: "pip", name: "Pip", label: "Planning", tasks: [task("np1", "Main", 1000, "4:40 PM", "Ready when you are.", { ask: "Hello" })] }],
  };

  const S = {
    order: p("gateways") === "one" ? ["home"] : ["home", "studio"],
    inUse: "home",
    conn: "connected", // connected, connecting, unreachable, none
    target: null, // the gateway being connected to
    waiting: p("waiting") === "1" ? 1 : 0, // messages to Otto not yet sent to the gateway in use
    page: p("gw") || null, // a gateway's page in Settings
    added: null, // how adding ended: added, same, noid, nothing
    removal: null, // { id, outcome, items }
    os: ["mac", "windows", "linux"].includes(p("os")) ? p("os") : "mac",
    dev: p("build") === "dev",
    feed: p("feed") === "1",
    upd: p("upd") || "idle",
    version: "0.1.0",
    auto: false,
    spell: p("spell") || (p("os") === "windows" ? "ready" : "on"), // on, off, downloading, failed, ready (Windows)
    hw: p("hw") || "on", // on, pending (off at the next start), off, pendingOn
    saveFail: p("savefail") === "1",
    unsaved: false,
    // A protocol refusal on Home gateway's connection: "client" (this build is older) or "gateway" (the gateway is).
    refused: ["client", "gateway"].includes(p("required")) ? p("required") : null,
    retryOk: p("retryok") === "1", // the next handshake succeeds
    install: p("install") === "1", // the updater offers a replacement this build can install
    compact: p("compact") || "none",
    reply: p("reply") || "done",
    foldOpen: false,
    replyOpen: false,
    disk: p("disk"),
    diskClosed: false,
  };
  const gw = (id) => GW[id];
  const inUseName = () => (S.inUse ? gw(S.inUse).name : "No gateway");
  const others = () => S.order.filter((id) => id !== S.inUse);

  // Compact: Juniper's task "Heat pump vs. gas furnace" -------------------------------------------

  const turn = (role, html) => `<div class="turn" data-role="${role}" data-testid="transcript-turn">${html}</div>`;
  const bubble = (role, html) => `<div class="msg" data-role="${role}"><div class="bubble">${html}</div></div>`;
  const EARLIER = [
    ["What should I ask an installer before signing anything?", "Ask about sizing, the backup heat, the warranty, the noise and who services it. Get each answer in writing."],
    ["What size should it be for a 1,600 square foot house?", "It depends on the heat loss, not the area. Ask for a room-by-room load calculation before any quote."],
    ["Is a cold-climate model worth it here?", "Yes, if winters often go below -15 °C. It keeps its output where a standard one falls off."],
  ];
  const earlierTurns = () => EARLIER.map(([q, a]) => turn("user", bubble("user", esc(q))) + turn("assistant", bubble("assistant", esc(a)))).join("");
  const REPLY = {
    failed: "⚙️ Compaction failed: Compaction safeguard could not summarize the session: Summarization failed for 15 messages • Context 9.7k/128k (8%)",
    stopped: "⚙️ Compaction failed: Compaction safeguard could not summarize the session • Context 9.9k/128k (8%) ⚠️ Your in-flight request was aborted by compaction — please resend it.",
  };
  function compactHtml() {
    const c = S.compact;
    const stamp = `<div class="stamp">Today 5:24 PM</div>`;
    const running = c === "running" || c === "stopped" ? turn("user", bubble("user", "Compare the running costs over ten years.")) : "";
    if (c === "done")
      return (
        stamp +
        `<div class="s-compacted" data-testid="compacted"><div class="s-compacted-line"><span class="event-line">Context compacted · 9.7k → 2.1k tokens</span>` +
        `<button type="button" class="s-compacted-toggle" data-s="fold" aria-expanded="${S.foldOpen}" aria-controls="s-fold-j1">${icon("chevron")}3 earlier turns</button></div>` +
        `<div class="s-compacted-turns" id="s-fold-j1"${S.foldOpen ? "" : " hidden"}>${earlierTurns()}` +
        `<p class="s-compacted-foot">Juniper's context now holds a summary of these and its most recent messages.</p></div></div>`
      );
    const line = {
      compacting: `<div class="event-line" data-testid="compact-line"><span class="status-dot" data-status="connecting"></span> Compacting Juniper's context…</div>`,
      skipped: `<div class="event-line" data-testid="compact-line">Nothing to compact yet.</div>`,
      failed: `<div class="s-compacted" data-testid="compact-line"><div class="s-compacted-line"><span class="event-line">Couldn't compact. Juniper's context is as it was.</span>` +
        `<button type="button" class="s-compacted-toggle" data-s="reply" aria-expanded="${S.replyOpen}" aria-controls="s-reply">${icon("chevron")}Show the gateway's reply</button></div>` +
        `<p class="s-reply" id="s-reply"${S.replyOpen ? "" : " hidden"}>${esc(REPLY.failed)}</p></div>`,
      stopped: `<div class="s-compacted" data-testid="compact-line"><div class="s-compacted-line"><span class="event-line">Couldn't compact. Juniper's context is as it was.</span>` +
        `<button type="button" class="s-compacted-toggle" data-s="reply" aria-expanded="${S.replyOpen}" aria-controls="s-reply">${icon("chevron")}Show the gateway's reply</button></div>` +
        `<p class="s-warn-line">The gateway stopped the run that was going. Send that message again.</p>` +
        `<p class="s-reply" id="s-reply"${S.replyOpen ? "" : " hidden"}>${esc(REPLY.stopped)}</p></div>`,
    }[c];
    return stamp + earlierTurns() + running + (line || "");
  }
  let j1 = null;

  // The extension of app.js ------------------------------------------------------------------------

  let HOME = null;
  let appBots = null;
  CT.appExtension = {
    fixtures(bots) {
      appBots = bots;
      j1 = bots.find((b) => b.id === "juniper").tasks.find((t) => t.id === "j1");
      if (S.compact === "running") j1.status = "running";
      j1.html = compactHtml();
      HOME = bots.slice();
    },
    panel(b, t) {
      $("#files-empty").textContent = `Files ${b.name} reads or writes in this task appear here.`;
      $("#computer-empty").textContent = `When ${b.name} uses a browser or a desktop, you can watch it here.`;
      if (t) $("#panel-details").insertAdjacentHTML("beforeend", contextGroup(b, t));
    },
  };

  function contextGroup(b, t) {
    const read = window.app?.model.access === "read";
    const isJ1 = t === j1;
    const running = t.status === "running";
    const busy = isJ1 && S.compact === "compacting";
    let body;
    if (read)
      body =
        `<p>Compacting sends a message, which needs this device to be able to send.</p>` +
        `<section class="access-bar" role="region" aria-label="Access" data-state="none"><div class="access-row">${icon("eye")}` +
        `<span class="shelf-text"><b>Read-only.</b> Compacting needs this device to be able to send.</span>` +
        `<button type="button" class="button" data-variant="primary" data-size="sm" data-b="request-write" data-s="after-access">Request access</button></div></section>`;
    else if (busy) body = `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Compacting…</p>`;
    else if (running)
      body =
        `<p>Compact is available when this run ends. The gateway would stop a run still going a minute after you compact.</p>` +
        `<button type="button" class="button" data-size="sm" disabled>Compact</button>`;
    else
      body =
        `<p>Compact asks the gateway to replace older turns in ${esc(b.name)}'s context with a summary. Every turn stays here.</p>` +
        `<button type="button" class="button" data-size="sm" data-s="compact">Compact</button>`;
    return `<section class="work-section s-context" data-testid="context-group"><h3>Context</h3>${body}</section>`;
  }

  // Everything that needs bots.js -------------------------------------------------------------------

  document.addEventListener("DOMContentLoaded", () => {
    const app = window.app;
    const D = CT.botsData;
    const settingsDialog = $("#settings-dialog");
    const confirmDialog = $("#confirm-dialog");
    const stand = $("#s-stand");
    const button = D.button;
    const note = D.note;
    const announce = D.announce;
    const back = D.back;
    const isAdmin = D.isAdmin;
    const phone = () => CT.settings.width === "phone";
    const rs = (focus) => {
      if (!settingsDialog.open) return;
      D.renderSettings();
      if (focus) D.focusFirst(settingsDialog);
    };
    const rerenderTask = () => app.openTask(app.model.selectedBot, app.model.selectedTask);

    // The section list, in the order of settings.md section 3. System and Updates are desktop only.
    const SECTIONS = CT.botsSections;
    function placeSections() {
      const keep = SECTIONS.filter(([id]) => !["gateways", "appearance", "system", "updates"].includes(id));
      const mine = [["appearance", "Appearance"], ...(phone() ? [] : [["system", "System"], ["updates", "Updates"]])];
      SECTIONS.splice(0, SECTIONS.length, keep[0], ["gateways", "Your gateways"], ...keep.slice(1), ...mine);
    }
    placeSections();
    document.addEventListener("ct:settings", () => {
      placeSections();
      if (phone() && ["system", "updates"].includes(D.B.settings.section)) D.B.settings.section = "appearance";
      rs();
      renderRequired();
    });

    // The gateway menu and the rail's footer ----------------------------------------------------------

    function renderMenu() {
      const holder = $("#s-menu-gateways");
      const items = S.order
        .map(
          (id) =>
            `<li role="none" data-s-menu-item><button type="button" class="menu-item" role="menuitemradio" aria-checked="${id === S.inUse}" data-s="switch" data-gw="${id}">${esc(gw(id).name)}<span class="glyph" data-state="check"></span></button></li>`,
        )
        .join("");
      $$("[data-s-menu-item]").forEach((li) => li.remove());
      holder.insertAdjacentHTML("afterend", items);
      holder.hidden = true;
      const name = inUseName();
      const state = { connected: "Connected", connecting: "Connecting…", unreachable: "Can't reach the gateway", none: "Not connected", refused: "Can't use it" }[S.conn];
      $(".gateway-pill strong").textContent = S.conn === "connecting" ? gw(S.target).name : name;
      $("#gateway-state").textContent = state;
      $("#gateway-menu .menu-head strong").textContent = S.conn === "connecting" ? gw(S.target).name : name;
      $("#gateway-menu-state").textContent = S.inUse ? `${state} · ${gw(S.inUse).route}` : state;
      $$('[data-action="gateway-menu"]').forEach((b) => b.setAttribute("aria-label", `${S.conn === "connecting" ? gw(S.target).name : name}, ${state.toLowerCase().replace("…", "")}. Open the gateway menu.`));
      $$(".rail .status-dot").forEach((dot) => (dot.dataset.status = { connected: "connected", connecting: "connecting", unreachable: "error", none: "disconnected", refused: "error" }[S.conn]));
    }
    const closeGatewayMenu = () => {
      if (!$("#gateway-menu").hidden) $(".gateway-pill").click();
    };

    function strip(text, more, actions, tone) {
      const el = $("#status-strip");
      el.hidden = !text;
      $(".conversation").dataset.strip = String(Boolean(text));
      if (!text) return;
      el.dataset.tone = tone || "warn";
      el.innerHTML = `<span class="status-dot"></span><span class="status-strip-text">${text}${more ? `<span>· ${more}</span>` : ""}</span>${actions || ""}`;
    }

    // Between two gateways nothing of either is shown.
    function showEmpty(title, text, busy) {
      $("#bot-list").innerHTML = `<li class="rail-empty"${busy ? ' aria-busy="true"' : ""}><strong>${title}</strong>${text}</li>`;
      $("#transcript").innerHTML = `<div class="transcript-inner"><div class="work-empty"><h4>${title}</h4><p>${text}</p></div></div>`;
      $("#composer").hidden = true;
      $("#title-pill").hidden = true;
      app.setPanel(false);
      $$(".s-disk-note").forEach((n) => n.remove());
    }

    // Switching (section 6) ------------------------------------------------------------------------------

    const SWITCH_FAIL = p("switchfail") === "1";
    let timer = null;
    function connectTo(id, then) {
      clearTimeout(timer);
      S.target = id;
      S.conn = "connecting";
      if (S.inUse) S.last = S.inUse;
      S.inUse = null;
      showEmpty("Loading bots", "Loading this gateway's bots.", true);
      strip(`Connecting to ${esc(gw(id).name)}`);
      renderMenu();
      rs();
      timer = setTimeout(() => {
        if (SWITCH_FAIL && id === "studio" && !S.retried) {
          S.conn = "unreachable";
          showEmpty(`Can't reach ${esc(gw(id).name)}`, "It didn't answer.");
          strip(
            `Can't reach ${esc(gw(id).name)}`,
            "it didn't answer",
            `<button type="button" data-s="retry-switch">Retry</button>` + (S.last && S.last !== id ? `<button type="button" data-s="switch-back">Back to ${esc(gw(S.last).name)}</button>` : ""),
            "danger",
          );
          renderMenu();
          rs();
          announce(`Couldn't reach ${gw(id).name}`);
          return;
        }
        arrive(id);
        then?.();
      }, 900);
    }
    function arrive(id) {
      S.refused = null;
      S.inUse = id;
      S.target = null;
      S.conn = "connected";
      const set = id === "home" ? HOME : BOTS[id]();
      appBots.splice(0, appBots.length, ...set);
      app.model.remembered = id === "home" ? { otto: "o1" } : {};
      app.model.unfolded.clear();
      $("#composer").hidden = false;
      $("#title-pill").hidden = false;
      app.setConnection("connected");
      app.selectBot(set[0].id === "juniper" && id === "home" ? "otto" : set[0].id);
      strip("");
      renderMenu();
      rs();
      diskNote();
    }
    function switchTo(id, confirmed) {
      closeGatewayMenu();
      if (id === S.inUse && S.conn === "connected") return;
      if (S.waiting && S.inUse && !confirmed) {
        return confirmBox({
          title: `Switch to ${esc(gw(id).name)}?`,
          text: `${S.waiting} message to Otto hasn't been sent to ${esc(gw(S.inUse).name)} yet. Switching discards it: it isn't kept as a draft. Runs on ${esc(gw(S.inUse).name)} keep going.`,
          label: "Switch",
          run: () => switchTo(id, true),
        });
      }
      S.waiting = 0;
      S.added = null;
      S.removal = null;
      connectTo(id, () => announce(`Switched to ${gw(id).name}`));
    }

    // A confirmation in the shell's alertdialog: Cancel first, the action last.
    let confirmRun = null;
    function confirmBox({ title, text, body = "", label, run, tone = "" }) {
      confirmRun = run;
      confirmDialog.innerHTML =
        `<div class="s-confirm"><h2 id="confirm-title">${title}</h2><p id="confirm-text">${text}</p>${body}` +
        `<div class="b-actions">${button("Cancel", 'data-s="confirm-cancel"', "quiet")}${button(label, `data-s="confirm-ok"${tone ? ` data-tone="${tone}"` : ""}`)}</div></div>`;
      CT.hydrate(confirmDialog);
      confirmDialog.showModal();
      $('[data-s="confirm-cancel"]', confirmDialog).focus();
    }

    // Adding (section 5) ---------------------------------------------------------------------------------

    function openAdd(confirmed) {
      closeGatewayMenu();
      if (S.waiting && S.inUse && !confirmed) {
        return confirmBox({
          title: "Add a gateway?",
          text: `${S.waiting} message to Otto hasn't been sent to ${esc(gw(S.inUse).name)} yet. Adding a gateway disconnects from it while setup runs, which discards the message: it isn't kept as a draft. Runs on ${esc(gw(S.inUse).name)} keep going.`,
          label: "Add gateway",
          run: () => openAdd(true),
        });
      }
      S.waiting = 0;
      S.removal = null;
      S.addFrom = S.inUse || S.last || "home";
      stand.innerHTML =
        `<div class="s-confirm"><span class="s-stand-mark">Prototype stand-in</span><h2 id="s-stand-title">Adding a gateway</h2>` +
        `<p>Adding a gateway. ${esc(gw(S.addFrom).name)} stays saved; Cancel goes back to it.</p>` +
        `<p style="margin-top:8px">In the app, the setup flow runs here: “Where does OpenClaw run?”, then setup's own screens (<a href="setup.html">setup.html</a>). Choose how it ends:</p>` +
        `<div class="s-stand-choices">${button("Paired: a new gateway", 'data-s="add-new"')}${button("Paired: the same gateway", 'data-s="add-same"')}` +
        `${button("Paired: no identity", 'data-s="add-noid"')}${button("Setup failed", 'data-s="add-failed"')}</div>` +
        `<div class="b-actions">${button("Cancel", 'data-s="add-cancel"', "quiet")}</div></div>`;
      stand.showModal();
      $('[data-s="add-cancel"]', stand).focus();
    }
    function addEnded(how) {
      stand.close();
      S.added = how;
      S.page = null;
      const showResult = () => {
        if (!settingsDialog.open) D.openSettings($(".gateway-pill"), "gateways");
        D.B.settings.section = "gateways";
        D.B.settings.pane = "section";
        rs(true);
      };
      if (how === "new" || how === "noid") {
        const id = how === "new" ? "lab" : "noid";
        if (!S.order.includes(id)) S.order.push(id);
        connectTo(id, () => {
          announce(`Added ${gw(id).name}`);
          showResult();
        });
      } else {
        connectTo(S.addFrom, () => {
          announce(how === "same" ? `${gw(S.addFrom).name} is already here` : "Nothing was added");
          showResult();
        });
      }
      showResult();
    }

    // Removing (section 7) -------------------------------------------------------------------------------

    const RMFAIL = p("rmfail");
    function removalItems(id) {
      const g = gw(id);
      const other = S.order.find((x) => x !== id);
      const removed = [
        ["token", "Its pairing: the device token Clawtrate keeps for its route"],
        ["route", g.kind === "ssh" ? `Its route: ${g.route}, with the key Clawtrate pinned for it` : `Its address: ${g.route}`],
        ...(g.drafts ? [["drafts", `Drafts in ${g.drafts} tasks`]] : []),
        ...(id === S.inUse && S.waiting ? [["waiting", `${S.waiting} message to Otto that hasn't been sent yet`]] : []),
        ["arrangement", "How you arranged its bots in the rail, and the task last open"],
      ];
      const stays = [
        ["gateway", `On ${g.name}: its bots, tasks, accounts and settings. Nothing there changes.`],
        ["key", other ? `This device's key. ${gw(other).name} knows this device by it too.` : "This device's key, for a gateway you add later."],
      ];
      return { removed, stays };
    }
    const canRemoveRecord = (id) => id === S.inUse && S.conn === "connected" && isAdmin();
    function goesList(id, marks) {
      const { removed, stays } = removalItems(id);
      const g = gw(id);
      const command = `openclaw devices remove ${DEVICE}`;
      const mark = (key) => (marks ? marks[key] || "done" : null);
      const item = (key, text, kind) => {
        const m = mark(key);
        const ic = kind === "stays" ? "check" : m === "left" ? "warning" : m === "untried" ? "clock" : "x";
        const after = m === "left" ? "<small>Still on this device</small>" : m === "untried" ? "<small>Not tried</small>" : marks && kind !== "stays" ? "<small>Removed</small>" : "";
        return `<li data-kind="${kind}"${m && kind !== "stays" ? ` data-done="${m}"` : ""}>${icon(ic)}<span>${esc(text)}${after}</span></li>`;
      };
      const record =
        marks?.record === "done"
          ? `<li data-kind="removed" data-done="done">${icon("x")}<span>This device's record on ${esc(g.name)}<small>${esc(g.name)} removed it</small></span></li>`
          : canRemoveRecord(id) && !marks
            ? ""
            : `<li data-kind="stays">${icon("check")}<span>On ${esc(g.name)}: this device's record, device ${DEVICE.slice(0, 6)}. To remove it, run this on the gateway's computer:` +
              `<span class="command-line"><code>${command}</code>${D.copy("remove command", command)}</span></span></li>`;
      return (
        `<div class="s-goes" data-testid="removal-list"><h3>Removed from this device</h3><ul>` +
        (marks?.record === "done" ? record : "") +
        removed.map(([k, t]) => item(k, t, "removed")).join("") +
        `</ul><h3>Stays</h3><ul>${stays.slice(0, 1).map(([k, t]) => item(k, t, "stays")).join("")}${marks?.record === "done" ? "" : record}${stays.slice(1).map(([k, t]) => item(k, t, "stays")).join("")}</ul></div>`
      );
    }
    function openRemove(id) {
      const g = gw(id);
      const box = canRemoveRecord(id)
        ? `<label class="s-check"><input type="checkbox" data-s-record /> <span>Also remove this device's record from ${esc(g.name)}</span></label>`
        : "";
      const ssh = g.kind === "ssh" ? `<p style="margin-top:12px">Clawtrate stops its forward to devbox. OpenClaw on devbox keeps running.</p>` : "";
      confirmBox({
        title: `Remove ${esc(g.name)} from this device?`,
        text: canRemoveRecord(id) ? "Nothing on the gateway changes unless you tick the box below." : "Nothing on the gateway changes.",
        body: goesList(id) + box + ssh,
        label: "Remove",
        tone: "danger",
        run: () => runRemoval(id, Boolean($("[data-s-record]", confirmDialog)?.checked)),
      });
      S.removing = id;
    }
    function runRemoval(id, record, attempt = 1) {
      const g = gw(id);
      // Only a result that names this device's id counts as removed (settings.md section 7).
      if (record && (RMFAIL === "remote" || RMFAIL === "unknown")) {
        S.removal = { id, outcome: RMFAIL };
        return showRemoval();
      }
      if (RMFAIL === "local" && attempt === 1 && !S.localRetried) {
        S.removal = { id, outcome: "local", marks: { token: "done", route: "done", drafts: "left", waiting: "left", arrangement: "untried", ...(record ? { record: "done" } : {}) }, record };
        return showRemoval();
      }
      // Done: the gateway is gone from this device.
      S.removal = { id, outcome: "done", marks: record ? { record: "done" } : {}, record };
      S.order = S.order.filter((x) => x !== id);
      if (S.page === id) S.page = null;
      if (id === S.inUse) {
        S.inUse = null;
        S.last = null;
        S.conn = "none";
        S.waiting = 0;
        if (!S.order.length) {
          location.href = "setup.html";
          return;
        }
        showEmpty("Not connected", "Choose a gateway to use.");
        strip("");
      }
      renderMenu();
      announce(`${g.name} is removed from this device`);
      showRemoval();
    }
    function showRemoval() {
      if (!settingsDialog.open) D.openSettings($(".gateway-pill"), "gateways");
      D.B.settings.section = "gateways";
      D.B.settings.pane = "section";
      S.page = null;
      rs(true);
    }
    function removalResult() {
      const r = S.removal;
      if (!r) return "";
      const g = gw(r.id);
      if (r.outcome === "remote")
        return (
          `<div class="s-result" data-testid="removal-result">${D.result("danger", "warning", `${esc(g.name)} didn't remove this device's record`, `Nothing was removed. ${esc(g.name)} said: the request was refused.`)}` +
          `<div class="b-actions" style="justify-content:center">${button("Cancel", 'data-s="rm-cancel"', "quiet")}${button("Remove from this device only", `data-s="rm-local" data-gw="${r.id}"`)}</div></div>`
        );
      if (r.outcome === "unknown")
        return (
          `<div class="s-result" data-testid="removal-result">${D.result("warn", "warning", `Clawtrate can't tell whether ${esc(g.name)} removed this device's record`, `Nothing else was removed. Look for this device in ${esc(g.name)}'s device list on the gateway's computer.`)}` +
          `<div class="b-actions" style="justify-content:center">${button("Cancel", 'data-s="rm-cancel"', "quiet")}${button("Remove from this device only", `data-s="rm-local" data-gw="${r.id}"`)}</div></div>`
        );
      if (r.outcome === "local")
        return (
          `<div class="s-result" data-testid="removal-result">${D.result("danger", "warning", "Couldn't remove everything", "Some of it is still on this device. Try again removes only what is left.")}` +
          goesList(r.id, r.marks) +
          `<div class="b-actions" style="justify-content:center;margin-top:14px">${button("Try again", `data-s="rm-retry" data-gw="${r.id}"`, "primary")}</div></div>`
        );
      return (
        `<div class="s-result" data-testid="removal-result">${D.result("ok", "check", `${esc(g.name)} is removed from this device`, "What was removed, and what stays:")}` +
        goesList(r.id, { ...r.marks }) +
        `</div>`
      );
    }

    // Settings: the Gateway pane, as built, with "Other gateways" and Remove (section 3) -------------------

    CT.botsGatewayPane = () => {
      if (!S.inUse) {
        return {
          title: "Gateway",
          back: back("Back to settings", "to-nav"),
          body: `<p class="b-lead">${S.conn === "connecting" ? `Connecting to ${esc(gw(S.target).name)}…` : "Not connected."}</p>${button("Your gateways", 'data-s="to-gateways" data-size="sm"')}`,
        };
      }
      const g = gw(S.inUse);
      const scopes = { read: ["operator.read"], write: ["operator.read", "operator.write", "operator.approvals", "operator.questions"], admin: ["operator.read", "operator.write", "operator.approvals", "operator.questions", "operator.admin"] }[D.B.access];
      const refused = S.conn === "refused";
      const theirs = S.refused === "client" ? 5 : 3;
      const body =
        `<dl class="facts"><div><dt>Address</dt><dd>${esc(g.route)}</dd></div><div><dt>State</dt><dd>${refused ? "Can't use it" : "Connected"}</dd></div>` +
        `<div><dt>This device</dt><dd class="mono">device ${DEVICE.slice(0, 6)}</dd></div><div><dt>Granted scopes</dt><dd class="b-wrap-value">${refused ? "None while not connected" : scopes.join(", ")}</dd></div>` +
        `<div><dt>${refused ? "Last seen" : "Gateway"}</dt><dd>${refused ? (S.refused === "gateway" ? "OpenClaw 2026.4.2 on Nov 12" : "OpenClaw 2026.10.6 on Nov 18") : "OpenClaw 2026.10.6"}</dd></div></dl>` +
        (refused
          ? `<div class="form-error" role="alert" data-testid="gateway-problem"><strong>This gateway speaks another protocol</strong>The address saved for ${esc(g.name)} replied with protocol ${theirs}. This version of Clawtrate speaks protocol 4.${S.refused === "gateway" ? " Update OpenClaw on the gateway's computer to use it with this version." : ""}</div>`
          : "") +
        `<div class="b-actions" style="margin-top:16px">${button("Disconnect", 'data-action="disconnect" data-size="sm"')}${button("Other gateways", 'data-s="to-gateways" data-size="sm"', "quiet")}` +
        `<span class="spacer"></span>${button("Remove this gateway…", `data-s="remove" data-gw="${S.inUse}" data-size="sm" data-tone="danger"`, "quiet")}</div>`;
      return { title: "Gateway", back: back("Back to settings", "to-nav"), body };
    };

    // Your gateways (section 4) --------------------------------------------------------------------------

    CT.botsSectionViews.gateways = () => {
      if (S.page && gw(S.page) && S.order.includes(S.page) && S.page !== S.inUse) return gatewayPage(gw(S.page));
      const addedText = {
        new: ["ok", "check", "Added Lab gateway", "Clawtrate is connected to it, read-only. Home gateway stays saved: switch back from the gateway menu."],
        same: ["ok", "check", "Home gateway is already here", "This address leads to Home gateway. Clawtrate keeps its saved pairing and didn't add a second entry. A second way to reach one gateway is a route, in Settings, Gateway."],
        noid: ["warn", "warning", "Added 198.51.100.7", "Lab gateway didn't say who it is, so Clawtrate keeps it under its address."],
        failed: ["warn", "warning", "Nothing was added", `Clawtrate is connected to ${esc(gw(S.addFrom || "home").name)} again.`],
        cancelled: ["warn", "warning", "Nothing was added", `Clawtrate is connected to ${esc(gw(S.addFrom || "home").name)} again.`],
      }[S.added];
      const added = addedText && S.conn === "connected" ? `<div class="s-result" data-testid="add-result">${D.result(...addedText)}</div>` : "";
      const row = (id) => {
        const g = gw(id);
        const sub =
          id === S.inUse
            ? `${esc(g.route)} · ${S.conn === "refused" ? "Can't use it" : "In use"}`
            : id === S.target && S.conn === "connecting"
              ? `${esc(g.route)} · Switching`
              : id === S.target && S.conn === "unreachable"
                ? `${esc(g.route)} · <span data-tone="danger">Can't reach it</span>`
                : `${esc(g.route)} · Last used ${esc(g.last)}`;
        const text = `<span class="b-choice-text"><span class="b-choice-title">${esc(g.name)}</span><span class="b-choice-sub">${sub}</span></span>`;
        if (id === S.inUse) return `<li><button type="button" class="b-choice" data-s="open-gw" data-gw="${id}">${text}${icon("chevron")}</button></li>`;
        return (
          `<li><div class="b-choice s-gateway-row" data-gw-row="${id}">${text}<span class="s-row-end">` +
          (S.conn === "connecting" && id === S.target ? "" : button("Switch", `data-s="switch" data-gw="${id}" data-size="sm" aria-label="Switch to ${esc(g.name)}"`)) +
          `<button type="button" class="icon-button" data-variant="quiet" data-s="open-gw" data-gw="${id}" aria-label="${esc(g.name)}'s page">${icon("chevron")}</button></span></div></li>`
        );
      };
      const body =
        removalResult() +
        added +
        `<p class="s-lead">Clawtrate saves a separate connection for each gateway and uses one at a time.</p>` +
        (S.conn === "none" ? note("<p>Not connected. Choose a gateway to use.</p>", "warn") : "") +
        `<ul class="b-choices s-gateways" data-testid="gateway-list">${S.order.map(row).join("")}</ul>` +
        (S.order.length === 1 ? `<p class="b-hint">Add another gateway to switch between them here or from the gateway menu.</p>` : "") +
        `<div class="b-actions" style="margin-top:14px">${button("Add gateway…", 'data-s="add" data-size="sm"')}</div>`;
      return { title: "Your gateways", back: back("Back to settings", "to-nav"), body };
    };

    function gatewayPage(g) {
      const body =
        `<dl class="facts" data-testid="gateway-page"><div><dt>Route</dt><dd>${esc(g.route)}</dd></div><div><dt>Last used</dt><dd>${esc(g.last === "Just now" ? "Just now" : g.last)}</dd></div>` +
        `<div><dt>This device there</dt><dd>Paired, device ${DEVICE.slice(0, 6)} · ${esc(g.access || "Admin")}</dd></div>` +
        `<div><dt>Identity</dt><dd class="mono">${g.identity ? esc(g.identity) : "Not read"}</dd></div></dl>` +
        `<p class="b-hint">What Clawtrate recorded at its last connection. Nothing is read from a gateway that isn't in use.</p>` +
        `<div class="b-actions" style="margin-top:16px">${button(`Switch to ${esc(g.name)}`, `data-s="switch" data-gw="${g.id}" data-size="sm"`, "primary")}` +
        `<span class="spacer"></span>${button("Remove…", `data-s="remove" data-gw="${g.id}" data-size="sm" data-tone="danger"`, "quiet")}</div>`;
      const toList = `<button type="button" class="icon-button b-back" data-s="to-gateways-back" aria-label="Back to your gateways">${icon("back")}</button>`;
      return { title: esc(g.name), back: toList, body };
    }

    // Appearance (section 8) -----------------------------------------------------------------------------

    const seg = (label, key, current, options) =>
      `<div class="seg" role="radiogroup" aria-label="${label}">${options
        .map(([v, l]) => `<button type="button" role="radio" aria-checked="${current === v}" tabindex="${current === v ? 0 : -1}" data-s="${key}" data-value="${v}">${l}</button>`)
        .join("")}</div>`;
    const themeNow = () => (CT.settings.followSystem ? "system" : CT.settings.theme);
    const bubblesNow = () => (document.documentElement.dataset.bubbles === "neutral" ? "neutral" : "accent");
    CT.botsSectionViews.appearance = () => {
      const body =
        (S.unsaved ? note("<p>Clawtrate couldn't save this. It applies until you close Clawtrate.</p>", "warn") : "") +
        `<div class="s-group"><h4>Theme</h4><div class="s-setting"><span class="s-setting-main"><strong>Theme</strong><span>The same choice as the gateway menu's.</span></span>` +
        seg("Theme", "theme", themeNow(), [["system", "Follow system"], ["light", "Light"], ["dark", "Dark"]]) +
        `</div></div>` +
        `<div class="s-group"><h4>Your messages</h4><div class="s-setting"><span class="s-setting-main"><strong>Your messages</strong><span>The fill of what you send.` +
        `<span class="s-sample" data-fill="accent" aria-hidden="true">Accent</span><span class="s-sample" data-fill="neutral" aria-hidden="true">Neutral</span></span></span>` +
        seg("Your messages", "bubbles", bubblesNow(), [["accent", "Accent"], ["neutral", "Neutral"]]) +
        `</div></div>` +
        `<p class="b-hint">Kept on this device. Your other devices choose for themselves.</p>`;
      return { title: "Appearance", back: back("Back to settings", "to-nav"), body };
    };

    // System (section 9) ---------------------------------------------------------------------------------

    const sw = (on, attrs, label, described) =>
      `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}"${described ? ` aria-describedby="${described}"` : ""} ${attrs}></button>`;
    function spellLine() {
      if (S.spell === "off") return ["", "Spelling isn't checked."];
      if (S.os === "mac") return ["", "Uses macOS's own spelling checker, in the languages macOS is set to."];
      if (S.spell === "downloading") return ["", "Uses a dictionary for English (United States), which Clawtrate downloads once."];
      if (S.spell === "failed") return ["danger", "Couldn't download the dictionary for English (United States). Spelling isn't checked."];
      return ["", "Checks English (United States)."];
    }
    const HW = {
      on: ["Turn off if Clawtrate draws badly or flickers on this computer.", true, false],
      pending: ["Turns off when Clawtrate restarts.", false, true],
      off: ["Off. Clawtrate draws without the graphics hardware.", false, false],
      pendingOn: ["Turns on when Clawtrate restarts.", true, true],
    };
    CT.botsSectionViews.system = () => {
      const [tone, line] = spellLine();
      const [hwLine, hwOn, restart] = HW[S.hw];
      const body =
        `<div class="s-group"><h4>Spelling</h4><div class="s-setting"><span class="s-setting-main"><strong>Check spelling while typing</strong>` +
        `<span id="s-spell-line"${tone ? ` data-tone="${tone}"` : ""}>${line}</span>` +
        (S.spell === "failed" ? `<span class="s-setting-actions">${button("Try again", 'data-s="spell-retry" data-size="sm"')}</span>` : "") +
        `</span>${sw(S.spell !== "off", 'data-s="spell"', "Check spelling while typing", "s-spell-line")}</div></div>` +
        `<div class="s-group"><h4>Graphics</h4><div class="s-setting"><span class="s-setting-main"><strong>Use hardware acceleration</strong><span id="s-hw-line">${hwLine}</span>` +
        (restart ? `<span class="s-setting-actions">${button("Restart now", 'data-s="restart" data-size="sm"', "primary")}</span>` : "") +
        `</span>${sw(hwOn, 'data-s="hw"', "Use hardware acceleration", "s-hw-line")}</div></div>` +
        "";
      return { title: "System", back: back("Back to settings", "to-nav"), body };
    };

    // Updates (section 10) -------------------------------------------------------------------------------

    function updatesRow() {
      if (S.dev) return ["A development build. It doesn't update itself.", ""];
      if (!S.feed) return ["This copy can't check for updates: no update source is set up for it.", ""];
      if (S.os === "linux") return ["Updates are managed by your package manager.", ""];
      const check = button("Check for Updates", 'data-s="check" data-size="sm"');
      return {
        idle: ["Checked at 9:05 AM", check],
        checking: ["Checking for updates…", ""],
        current: [`You're up to date. Checked at 5:41 PM.`, check],
        downloading: [`Downloading Clawtrate 0.2.0…`, ""],
        ready: ["Clawtrate 0.2.0 is ready. It installs when Clawtrate restarts.", button("Restart to Update", 'data-s="restart-update" data-size="sm"', "primary")],
        error: ["Couldn't check for updates.", button("Try again", 'data-s="check" data-size="sm"')],
      }[S.upd];
    }
    CT.botsSectionViews.updates = () => {
      const [line, action] = updatesRow();
      const future = S.feed && !S.dev ? `<p class="s-future">${S.os === "linux" ? "When a Linux package is built" : "When releases are published"}: a future example. No update source exists today.</p>` : "";
      const auto =
        S.feed && !S.dev && S.os !== "linux"
          ? `<div class="s-setting" style="margin-top:14px"><span class="s-setting-main"><strong>Automatic Updates</strong>` +
            `<span id="s-auto-line">Install a downloaded update by itself while you're away: when the screen is locked, the computer has been idle for 10 minutes, and no run is active on the gateway Clawtrate is using.</span>` +
            `<em>Clawtrate can't tell when a screen saver is on, so only a locked screen counts.</em></span>${sw(S.auto, 'data-s="auto"', "Automatic Updates", "s-auto-line")}</div>`
          : "";
      const body =
        future +
        `<dl class="facts" data-testid="updates"><div><dt>Version</dt><dd>Clawtrate ${S.version}</dd></div><div><dt>Updates</dt><dd data-testid="updates-line">${line}</dd></div></dl>` +
        (action ? `<div class="b-actions" style="margin-top:14px">${action}</div>` : "") +
        auto;
      return { title: "Updates", back: back("Back to settings", "to-nav"), body };
    };
    function check() {
      S.upd = "checking";
      rs();
      setTimeout(() => {
        S.upd = p("next") === "update" ? "downloading" : "current";
        rs();
        if (S.upd === "current") announce("You're up to date");
        if (S.upd === "downloading")
          setTimeout(() => {
            S.upd = "ready";
            rs();
            announce("Clawtrate 0.2.0 is ready");
          }, 900);
      }, 900);
    }
    // A restart discards what waits to be sent, so it asks first when something does.
    function restart(title, after) {
      const go = () => {
        S.waiting = 0;
        after();
        rs(true);
      };
      if (!S.waiting) return go();
      confirmBox({
        title,
        text: `${S.waiting} message to Otto hasn't been sent yet. Restarting discards it: it isn't kept as a draft. Runs on ${esc(inUseName())} keep going.`,
        label: "Restart",
        run: go,
      });
    }

    // A protocol refusal (section 11): that connection's alone. The rail is empty, nothing is
    // asked of the gateway, and Your gateways, Add gateway and Remove stay reachable.
    function renderRequired() {
      if (!S.refused || S.inUse !== "home" || S.conn !== "refused") return;
      const name = gw("home").name;
      const theirs = S.refused === "client" ? 5 : 3;
      const canInstall = S.feed && S.install && !S.dev && !phone();
      const how =
        S.refused === "gateway"
          ? `<p>Update OpenClaw on the gateway's computer to use it with this version.</p>`
          : `<p>Update required to use ${esc(name)}. Other gateways aren't affected.</p>` +
            (phone()
              ? `<p>Look for a newer Clawtrate in the App Store, or in TestFlight if you test it there.</p>`
              : canInstall
                ? ""
                : `<p>This copy can't update itself. A newer Clawtrate is needed to use ${esc(name)}.</p>`);
      const tried = S.lastTry ? `<p class="s-tried" role="status">Tried again at 5:42 PM: protocol ${theirs} again.</p>` : "";
      showEmpty(`Can't use ${esc(name)}`, `The address saved for it replied with protocol ${theirs}.`);
      $("#transcript").innerHTML =
        `<div class="transcript-inner"><section class="s-refusal" aria-labelledby="s-refusal-title" data-testid="refusal">` +
        `<h2 id="s-refusal-title" tabindex="-1">Can't use ${esc(name)}</h2>` +
        `<p>The address saved for ${esc(name)} replied with protocol ${theirs}. This version of Clawtrate speaks protocol 4.</p>${how}${tried}` +
        `<div class="b-actions">${canInstall && S.refused === "client" ? button("Update", 'data-s="refusal-update"', "primary") : ""}` +
        `${button("Try again", 'data-s="refusal-retry"')}${button("Your gateways", 'data-s="refusal-gateways"', "quiet")}</div></section></div>`;
      strip(`Can't use ${esc(name)}`, `protocol ${theirs}`, `<button type="button" data-s="refusal-retry">Try again</button>`, "danger");
      renderMenu();
    }

    // Low disk (section 14) -------------------------------------------------------------------------------

    function diskNote() {
      $$(".s-disk-note").forEach((n) => n.remove());
      const comp = $("#composer");
      if (!S.disk || S.diskClosed || S.inUse !== "home" || app.model.selectedBot !== "otto" || comp.hidden || !app.model.selectedTask) return;
      const where =
        S.disk === "gateway"
          ? "Otto is set to run commands on the gateway's machine. The volume with its workspace has 4.2 GB free of 994 GB, as of 5:40 PM."
          : "Otto is set to run commands on media-box, which has 2.1 GB free of 512 GB, as of 5:40 PM.";
      const d = document.createElement("section");
      d.className = "s-disk-note";
      d.setAttribute("role", "region");
      d.setAttribute("aria-label", "Disk space");
      d.dataset.testid = "disk-note";
      d.innerHTML =
        `<div><p>${where}</p><p>Clawtrate deletes nothing. Whether Otto asks before it deletes a file depends on its command rules.</p></div>` +
        `<span class="s-row-end">${button("Show the computer", 'data-s="disk-computer" data-size="sm"')}${button("Otto's rules", 'data-s="disk-rules" data-size="sm"', "quiet")}` +
        `<button type="button" class="icon-button" data-variant="quiet" data-s="disk-close" aria-label="Close the disk note">${icon("x")}</button></span>`;
      comp.before(d);
    }
    new MutationObserver(() => {
      const n = $(".s-disk-note");
      if (S.disk && !S.diskClosed && (!n || n.nextElementSibling?.id !== "composer")) diskNote();
    }).observe($("#composer"), { childList: true, attributes: true, attributeFilter: ["hidden"] });

    // Compact (section 13) --------------------------------------------------------------------------------

    function compact() {
      const t = app.bots.find((b) => b.id === app.model.selectedBot)?.tasks.find((x) => x.id === app.model.selectedTask);
      if (!t) return;
      if (t !== j1) {
        t.html = (t.html ?? "") + `<div class="event-line" data-testid="compact-line">Nothing to compact yet.</div>`;
        rerenderTask();
        announce("Nothing to compact yet");
        return;
      }
      S.compact = "compacting";
      j1.html = compactHtml();
      rerenderTask();
      setTimeout(() => {
        S.compact = ["done", "skipped", "failed", "stopped"].includes(S.reply) ? S.reply : "done";
        S.foldOpen = false;
        j1.html = compactHtml();
        rerenderTask();
        announce({ done: "Compacted", skipped: "Nothing to compact yet", failed: "Couldn't compact", stopped: "Couldn't compact" }[S.compact]);
      }, 1200);
    }

    // Clicks ----------------------------------------------------------------------------------------------

    document.addEventListener("click", (event) => {
      const el = event.target.closest("[data-s]");
      if (!el) return;
      const id = el.dataset.gw;
      switch (el.dataset.s) {
        case "switch":
          return switchTo(id);
        case "retry-switch":
          S.retried = true;
          return connectTo(S.target || "studio", () => announce(`Switched to ${gw(S.inUse).name}`));
        case "switch-back":
          return connectTo(S.last || "home", () => announce(`Switched to ${gw(S.inUse).name}`));
        case "open-switch":
          return $(".gateway-pill").click();
        case "confirm-cancel":
          confirmDialog.close();
          confirmRun = null;
          return;
        case "confirm-ok": {
          const run = confirmRun;
          confirmRun = null;
          run?.();
          confirmDialog.close();
          return;
        }
        case "add":
          return openAdd();
        case "add-new":
          return addEnded("new");
        case "add-same":
          return addEnded("same");
        case "add-noid":
          return addEnded("noid");
        case "add-failed":
          return addEnded("failed");
        case "add-cancel":
          return addEnded("cancelled");
        case "to-gateways":
        case "to-gateways-back":
          D.B.settings.section = "gateways";
          D.B.settings.pane = "section";
          S.page = null;
          return rs(true);
        case "open-gw":
          if (id === S.inUse) {
            D.B.settings.section = "gateway";
          } else S.page = id;
          return rs(true);
        case "remove":
          return openRemove(id);
        case "rm-cancel":
          S.removal = null;
          return rs(true);
        case "rm-local":
          return runRemoval(id, false);
        case "rm-retry":
          S.localRetried = true;
          return runRemoval(id, S.removal?.record, 2);
        case "theme":
          CT.setTheme(el.dataset.value);
          S.unsaved = S.saveFail;
          rs();
          $('[data-s="theme"][aria-checked="true"]', settingsDialog)?.focus();
          return announce(`Theme: ${{ system: "Follow system", light: "Light", dark: "Dark" }[el.dataset.value]}`);
        case "bubbles":
          if (el.dataset.value === "neutral") document.documentElement.dataset.bubbles = "neutral";
          else delete document.documentElement.dataset.bubbles;
          S.unsaved = S.saveFail;
          rs();
          $('[data-s="bubbles"][aria-checked="true"]', settingsDialog)?.focus();
          return announce(`Your messages: ${el.dataset.value === "neutral" ? "Neutral" : "Accent"}`);
        case "spell": {
          const turningOn = S.spell === "off";
          S.spell = turningOn ? (S.os === "windows" ? "downloading" : "on") : "off";
          rs();
          $('[data-s="spell"]', settingsDialog)?.focus();
          if (S.spell === "downloading")
            setTimeout(() => {
              S.spell = p("spell") === "failed" ? "failed" : "ready";
              rs();
              announce(S.spell === "ready" ? "Spelling is checked" : "Spelling isn't checked");
            }, 900);
          else announce(turningOn ? "Spelling is checked" : "Spelling isn't checked");
          return;
        }
        case "spell-retry":
          S.spell = "downloading";
          rs();
          return setTimeout(() => {
            S.spell = "ready";
            rs();
            announce("Spelling is checked");
          }, 900);
        case "hw":
          S.hw = { on: "pending", pending: "on", off: "pendingOn", pendingOn: "off" }[S.hw];
          rs();
          $('[data-s="hw"]', settingsDialog)?.focus();
          if (S.hw === "pending") announce("Hardware acceleration turns off when Clawtrate restarts");
          if (S.hw === "pendingOn") announce("Hardware acceleration turns on when Clawtrate restarts");
          return;
        case "restart":
          return restart("Restart Clawtrate?", () => {
            S.hw = S.hw === "pending" ? "off" : "on";
            announce(S.hw === "off" ? "Restarted. Hardware acceleration is off" : "Restarted. Hardware acceleration is on");
          });
        case "check":
          return check();
        case "restart-update":
          return restart("Restart to update?", () => {
            S.version = "0.2.0";
            S.upd = "current";
            announce("Restarted. Clawtrate 0.2.0");
          });
        case "auto":
          S.auto = !S.auto;
          rs();
          $('[data-s="auto"]', settingsDialog)?.focus();
          return announce(S.auto ? "Automatic Updates on" : "Automatic Updates off");
        case "refusal-retry":
          // A new handshake. The refusal stays until one succeeds.
          strip(`Connecting to ${esc(gw("home").name)}`);
          return setTimeout(() => {
            if (S.retryOk) {
              S.refused = null;
              S.lastTry = false;
              arrive("home");
              announce(`Connected to ${gw("home").name}`);
            } else {
              S.lastTry = true;
              renderRequired();
              announce(`Still can't use ${gw("home").name}`);
            }
          }, 600);
        case "refusal-update":
          return D.openSettings($(".gateway-pill"), "updates");
        case "refusal-gateways":
          return D.openSettings($(".gateway-pill"), "gateways");
        case "compact":
          return compact();
        case "after-access":
          return setTimeout(rerenderTask, 60);
        case "fold": {
          S.foldOpen = !S.foldOpen;
          el.setAttribute("aria-expanded", String(S.foldOpen));
          $("#s-fold-j1").hidden = !S.foldOpen;
          j1.html = compactHtml();
          return;
        }
        case "reply":
          S.replyOpen = !S.replyOpen;
          el.setAttribute("aria-expanded", String(S.replyOpen));
          $("#s-reply").hidden = !S.replyOpen;
          j1.html = compactHtml();
          return;
        case "disk-computer":
          app.setPanel(true);
          return app.setTab("computer");
        case "disk-rules":
          app.setPanel(true);
          return app.setTab("settings");
        case "disk-close":
          S.diskClosed = true;
          return diskNote();
      }
    });
    // A bot or task chosen in the rail: the disk note follows the open bot.
    document.addEventListener("click", (event) => {
      if (event.target.closest(".bot[data-bot], .task[data-task], .pin")) setTimeout(diskNote, 30);
    });
    confirmDialog.addEventListener("close", () => (confirmRun = null));

    // Prototype controls in the dark bar ------------------------------------------------------------------

    const extra = $("#proto-extra");
    if (extra) {
      extra.insertAdjacentHTML(
        "afterbegin",
        `<span class="run-controls"><button type="button" data-s-proto="waiting">Message waiting</button><span id="run-caption">Switch gateways from the gateway menu. Settings is in it too (⌘,).</span></span>`,
      );
      extra.addEventListener("click", (event) => {
        if (event.target.closest('[data-s-proto="waiting"]')) {
          S.waiting = S.waiting ? 0 : 1;
          event.target.setAttribute("aria-pressed", String(Boolean(S.waiting)));
        }
      });
    }

    // First paint from the address ------------------------------------------------------------------------

    if (S.refused) S.conn = "refused";
    renderMenu();
    renderRequired();
    diskNote();
    // The iPhone has no System and no Updates: an address that asks for one gets Appearance.
    if (phone() && ["system", "updates"].includes(D.B.settings.section)) D.B.settings.section = "appearance";
    if (settingsDialog.open) rs(true);
    if (p("add") === "1") openAdd(true);
    if (p("remove") && gw(p("remove"))) openRemove(p("remove"));
    window.settingsProto = { S, switchTo, openAdd, openRemove };
  });
})();
