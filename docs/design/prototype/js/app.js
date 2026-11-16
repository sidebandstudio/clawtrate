// Behaviour for app.html: open and close the Work pane, switch its tabs,
// move between list and detail on the phone, and show the states that the
// address asks for:
//   ?panel=open            Work pane open
//   ?tab=files             which Work pane tab
//   ?view=list             the phone's list view
//   ?banner=reconnecting   the connection strip: reconnecting, syncing, synced, failed, offline
//   ?state=empty           no task selected; also: loading, readonly
//   ?rail=pinned           pinned bots and a section name in the rail

(function () {
  const params = window.CT.params;
  const shell = document.querySelector(".shell");
  const banner = document.querySelector(".banner");

  function setPanel(open) {
    shell.dataset.panel = open ? "open" : "closed";
    document.querySelectorAll('.icon-button[data-action="panel"][aria-pressed]').forEach((button) => {
      button.setAttribute("aria-pressed", String(open));
      button.setAttribute("aria-label", open ? "Hide work pane" : "Show work pane");
    });
  }

  function setTab(name) {
    document.querySelectorAll("[data-tab]").forEach((tab) => {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
    });
    document.querySelectorAll("[data-tab-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.tabPanel !== name;
    });
  }

  const banners = {
    reconnecting: ["warn", "reconnecting", "Reconnecting <span>· showing saved messages</span>", "Retry now"],
    offline: ["danger", "error", "Can't reach Home gateway <span>· showing saved messages</span>", "Retry now"],
    syncing: ["warn", "connecting", "Connected <span>· catching up</span>", ""],
    synced: ["ok", "connected", "Synced <span>· 3 new in this task</span>", ""],
    failed: ["danger", "error", "Couldn't sync this task", "Try again"],
  };

  function setBanner(name) {
    const def = banners[name];
    banner.hidden = !def;
    if (!def) return;
    const [tone, status, html, action] = def;
    banner.dataset.tone = tone;
    banner.innerHTML =
      `<span class="status-dot" data-status="${status}"></span><span>${html}</span>` +
      (action ? `<button type="button">${action}</button>` : "");
  }

  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]")?.dataset.action;
    if (action === "panel") setPanel(shell.dataset.panel !== "open");
    if (action === "back") shell.dataset.view = "list";
    const tab = event.target.closest("[data-tab]");
    if (tab) setTab(tab.dataset.tab);
    if (event.target.closest(".task:not(.task-new), .bot")) shell.dataset.view = "detail";
    // A click on the scrim closes the drawer.
    if (event.target === shell && shell.dataset.panel === "open") setPanel(false);
  });

  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "\\") {
      event.preventDefault();
      setPanel(shell.dataset.panel !== "open");
    }
    if (event.key === "Escape" && shell.dataset.panel === "open") setPanel(false);
  });

  setPanel(params.get("panel") === "open");
  setTab(params.get("tab") || "details");
  setBanner(params.get("banner"));
  if (params.get("view")) shell.dataset.view = params.get("view");

  // ?rail=pinned shows pinned bots and a section name.
  if (params.get("rail") === "pinned") {
    const list = document.querySelector(".bot-list");
    const pins = ["juniper", "marlow", "pip"];
    const names = { juniper: "Juniper", marlow: "Marlow", pip: "Pip" };
    list.querySelectorAll(".bot-group:not([data-open])").forEach((group) => group.remove());
    list.insertAdjacentHTML(
      "afterbegin",
      `<li><ul class="pin-grid" aria-label="Pinned bots">` +
        pins
          .map(
            (id) =>
              `<li><button type="button" class="pin"><span class="avatar" data-bot="${id}"></span>` +
              `<span class="pin-name">${names[id]}</span></button></li>`,
          )
          .join("") +
        `</ul></li><li class="rail-section">home server</li>`,
    );
    window.CT.hydrate(list);
  }

  const state = params.get("state");
  const transcript = document.querySelector(".transcript");
  if (state === "empty") {
    transcript.innerHTML =
      '<div class="empty"><div><span class="avatar" data-bot="otto"></span><h3>Pick a task</h3>' +
      "<p>Choose one of Otto's tasks, or start a new one.</p></div></div>";
    window.CT.hydrate(transcript);
    document.querySelector(".title-pill-task").remove();
    document.querySelector('.task[aria-current="true"]').setAttribute("aria-current", "false");
  }
  if (state === "loading") {
    transcript.querySelector(".transcript-inner").innerHTML =
      '<div aria-busy="true" aria-label="Loading conversation">' +
      '<div class="skeleton" style="width:46%;margin-left:auto"></div>' +
      '<div class="skeleton" style="width:62%;height:88px;margin-top:16px"></div>' +
      '<div class="skeleton" style="width:38%"></div></div>';
  }
  if (state === "readonly") {
    const composer = document.querySelector(".composer");
    composer.dataset.readonly = "true";
    composer.querySelector(".composer-box").innerHTML =
      window.CT.icon("eye") + "<span>This device can read but not send. Ask the gateway owner for write access.</span>";
  }

  transcript.scrollTop = transcript.scrollHeight;
})();
