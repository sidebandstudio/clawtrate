// OpenClaw's settings inside Clawtrate's Settings: docs/design/gateway-settings.md.
// Prototype code, not product code.
//
// One state at a time, from the address:
//   screen   models (the default) | chat | telegram | pair | plugins | all | bot
//   done     1: the quiet line a change leaves, with Undo (models, plugins)
//   pending  1: two changes in All settings that restart OpenClaw, waiting in one Save
//   error    1: a value the form refuses before anything is written (all)
//   restart  1: OpenClaw restarting to apply a change; the banner above Settings
//   access   read: a connection without full control
//   connected telegram: Telegram connected, after the read-back of who may write (chat)
//   version  1006 | unknown: the restart words for 2026.10.6 or an unknown version (2026.11.10 otherwise)
//   q        the search in All settings (default "network")
//
// Every name, model, account, handle and value is made up. No token is drawn:
// a secret is "Set" or "Not set" and is never shown. The chat apps' marks are
// stand-ins; the product shows each app's own logo, as #797 decided for providers.

(function () {
  const { CT } = window;
  const p = CT.params;
  const root = document.getElementById("gs-root");
  const live = document.getElementById("gs-live");

  const state = {
    screen: p.get("screen") || "models",
    done: p.get("done") === "1",
    pending: p.get("pending") === "1",
    error: p.get("error") === "1",
    restart: p.get("restart") === "1",
    admin: p.get("access") !== "read",
    q: p.get("q") ?? "network",
    tip: null,
    model: p.get("done") === "1" ? "acme/swift-2" : "acme/swift-1",
    undoModel: "acme/swift-1",
    // The done line for plugins says Web search is on, so the fixture starts with it on.
    plugins: {
      voice: true,
      rules: true,
      bots: true,
      search: p.get("screen") === "plugins" && p.get("done") === "1",
    },
    // Set only after "That's me" and the read-back that only that sender may write.
    telegram: p.get("connected") === "telegram",
    version: p.get("version") || "1110",
  };

  const esc = (s) =>
    String(s).replace(
      /[&<>"']/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
    );
  const say = (text) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };

  const ICON = {
    check: '<svg class="icon gs-check" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    search: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    lock: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5.5a2.5 2.5 0 015 0V7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
    restart: '<svg class="icon" viewBox="0 0 16 16" aria-hidden="true" width="12" height="12"><path d="M13 8a5 5 0 11-1.5-3.6M13 2.5v2.5h-2.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // ---- fixtures --------------------------------------------------------------

  const MODELS = [
    { ref: "acme/swift-1", name: "Swift 1", provider: "Acme", account: "Work" },
    { ref: "acme/swift-2", name: "Swift 2", provider: "Acme", account: "Work" },
    { ref: "acme/deep-1", name: "Deep 1", provider: "Acme", account: "Home" },
    { ref: "globex/one", name: "Globex One", provider: "Globex", account: "Team" },
  ];
  const model = (ref) => MODELS.find((m) => m.ref === ref);
  const BOTS = [
    { name: "Juniper", own: null },
    { name: "Pip", own: null },
    { name: "Marlow", own: "globex/one" },
    { name: "Otto", own: "acme/deep-1" },
  ];
  const APPS = [
    ["telegram", "Telegram", "#2a9fd6", "T"],
    ["whatsapp", "WhatsApp", "#25a35a", "W"],
    ["discord", "Discord", "#5865f2", "D"],
    ["slack", "Slack", "#9b3f8f", "S"],
    ["signal", "Signal", "#3a76f0", "S"],
    ["imessage", "iMessage", "#2fb84f", "i"],
  ];

  // ---- small parts -------------------------------------------------------------

  const btn = (label, attrs = "", kind = "") =>
    `<button type="button" class="gs-btn"${kind ? ` data-kind="${kind}"` : ""} ${attrs}>${label}</button>`;
  const info = (id, text, path) =>
    `<button type="button" class="gs-info" aria-label="About this setting" aria-expanded="${state.tip === id}" aria-controls="tip-${id}" data-tip="${id}">i<span class="gs-tip" id="tip-${id}" role="tooltip"${state.tip === id ? "" : " hidden"}>${esc(text)}${path ? `<span class="gs-path">${esc(path)}</span>` : ""}</span></button>`;
  const sw = (id, on, label, disabled) =>
    `<button type="button" class="gs-switch" role="switch" aria-checked="${on}" aria-label="${esc(label)}" data-switch="${id}"${disabled ? " disabled" : ""}></button>`;
  const restartTag = `<span class="gs-tag" data-tone="warn">${ICON.restart}Restarts OpenClaw</span>`;
  const readOnlyNote = () =>
    state.admin
      ? ""
      : `<div class="gs-done" role="note"><span class="gs-done-text">This device can see OpenClaw's settings but not change them.</span>${btn("Ask for full control", 'data-size="sm"')}</div>`;

  const NAV = [
    ["gateway", "Gateway"],
    ["accounts", "Accounts"],
    ["models", "Models"],
    ["chat", "Chat apps"],
    ["plugins", "Plugins"],
    ["conversation", "Conversation"],
    ["usage", "Usage"],
    ["machines", "Machines"],
    ["updates", "Updates"],
    ["all", "All OpenClaw settings"],
    ["advanced", "Advanced"],
  ];
  const navFor = (screen) => (screen === "telegram" || screen === "pair" ? "chat" : screen);

  // ---- sections ----------------------------------------------------------------

  function modelsSection() {
    const m = model(state.model);
    const options = MODELS.map(
      (x) => `<option value="${x.ref}"${x.ref === state.model ? " selected" : ""}>${esc(x.name)} · ${esc(x.account)}</option>`,
    ).join("");
    const bots = BOTS.map((b) => {
      const own = b.own && model(b.own);
      const sub = own ? `${esc(own.name)} on ${esc(own.account)}` : `The default: ${esc(m.name)} on ${esc(m.account)}`;
      return `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">${b.name}</span><span class="gs-row-sub">${sub}</span></div><div class="gs-row-end">${btn("Change", `data-size="sm" aria-label="Change ${b.name}'s model"`, "quiet")}</div></div>`;
    }).join("");
    const done = state.done
      ? `<div class="gs-done" role="status">${ICON.check}<span class="gs-done-text">Default model is now ${esc(m.name)}, on ${esc(m.account)}.</span><button type="button" class="gs-link" data-action="undo-model">Put back ${esc(model(state.undoModel).name)}</button></div>`
      : "";
    const body =
      readOnlyNote() +
      `<div class="gs-group">For every bot</div><div class="gs-card">` +
      `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">Default model ${info("default", "The model a bot uses unless it has one of its own. It runs on the account shown beside it.", "agents.defaults.model.primary")}</span><span class="gs-row-sub">${esc(m.provider)} · runs on your ${esc(m.account)} account</span></div>` +
      `<div class="gs-row-end"><label class="visually-hidden" for="gs-default">Default model</label><select class="gs-select" id="gs-default" data-change="model"${state.admin ? "" : " disabled"}>${options}</select></div></div>` +
      `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">If it can't answer ${info("fallback", "When the default model fails or runs out, the bot tries these in order.", "agents.defaults.model.fallbacks")}</span><span class="gs-row-sub">Then Globex One, on Team</span></div><div class="gs-row-end">${btn("Change", 'data-size="sm"', "quiet")}</div></div>` +
      `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">Thinking ${info("thinking", "How long a bot thinks before it answers. More thinking is slower and can cost more.", "agents.defaults.thinkingDefault")}</span></div><div class="gs-row-end"><label class="visually-hidden" for="gs-think">Thinking</label><select class="gs-select" id="gs-think"${state.admin ? "" : " disabled"}><option>Low</option><option selected>Medium</option><option>High</option></select></div></div>` +
      `</div>${done}` +
      `<div class="gs-group">Each bot</div><div class="gs-card">${bots}</div>`;
    return { title: "Models", body };
  }

  function chatSection() {
    // A connected app is listed above, not offered again.
    const connected = ["whatsapp", ...(state.telegram ? ["telegram"] : [])];
    const tiles = APPS.filter(([id]) => !connected.includes(id)).map(
      ([id, label, color, letter]) =>
        `<button type="button" class="gs-tile" data-app="${id}"${state.admin ? "" : " disabled"}><span class="gs-mark" style="--mark:${color}" aria-hidden="true">${letter}</span>${label}</button>`,
    ).join("");
    const body =
      readOnlyNote() +
      `<div class="gs-group">Connected</div><div class="gs-card">` +
      `<div class="gs-row"><span class="gs-mark" style="--mark:#25a35a" aria-hidden="true">W</span><div class="gs-row-main"><span class="gs-row-title">WhatsApp</span><span class="gs-row-sub">Juniper answers · only you can message it</span></div><div class="gs-row-end"><span class="gs-tag" data-tone="ok">Connected</span>${btn("Open", 'data-size="sm"', "quiet")}</div></div>` +
      (state.telegram
        ? `<div class="gs-row"><span class="gs-mark" style="--mark:#2a9fd6" aria-hidden="true">T</span><div class="gs-row-main"><span class="gs-row-title">Telegram</span><span class="gs-row-sub">Juniper answers · only you can message it</span></div><div class="gs-row-end"><span class="gs-tag" data-tone="ok">Connected</span>${btn("Open", 'data-size="sm"', "quiet")}</div></div>`
        : "") +
      `</div>${state.telegram && state.done ? `<div class="gs-done" role="status">${ICON.check}<span class="gs-done-text">Telegram is connected. Only you can message Juniper there.</span><button type="button" class="gs-link">Disconnect</button></div>` : ""}<div class="gs-group">Connect a chat app</div><div class="gs-tiles">${tiles}</div>`;
    return { title: "Chat apps", body };
  }

  function steps(at) {
    const names = ["Connect", "Say hello"];
    return `<ol class="gs-steps" aria-label="Steps">${names
      .map((n, i) => `<li${i === at ? ' aria-current="step"' : ""}><span class="gs-num">${i + 1}</span><span class="gs-step-label">${n}</span></li>`)
      .join("")}</ol>`;
  }

  function telegramSection() {
    const body =
      steps(0) +
      `<p class="gs-note" style="margin:0 0 12px">Telegram makes the bot; Clawtrate does the rest.</p>` +
      `<ol class="gs-how"><li>In Telegram, open <strong>@BotFather</strong>.</li><li>Send <code>/newbot</code> and give your bot a name.</li><li>BotFather replies with a token. Copy it.</li></ol>` +
      `<div class="gs-actions" style="margin:0 0 18px">${btn("Open BotFather in Telegram", 'data-size="sm"')}</div>` +
      `<div class="gs-field"><label for="gs-token">Paste the token</label><input class="gs-input" id="gs-token" type="password" autocomplete="off" value="sample-not-a-token" aria-describedby="gs-token-note" /><p class="gs-note" id="gs-token-note">Kept on your OpenClaw, never shown again.</p></div>` +
      `<div class="gs-field"><label for="gs-answers">Who answers there</label><select class="gs-select" id="gs-answers"><option selected>Juniper</option><option>Pip</option><option>Marlow</option><option>Otto</option></select></div>`;
    const foot = `<div class="gs-actions" style="margin:0">${btn("Connect", 'data-action="to-pair"', "primary")}${btn("Cancel", 'data-nav="chat"', "quiet")}</div>`;
    return { title: "Connect Telegram", back: "chat", body, foot };
  }

  function pairSection() {
    const body =
      steps(1) +
      `<p style="margin:0 0 10px;font-size:var(--text-md)">Telegram is connected. Now send your bot any message from Telegram, so it knows it's you.</p>` +
      `<div class="gs-actions" style="margin:0 0 6px">${btn("Open @juniper_sample_bot in Telegram", 'data-size="sm"')}</div>` +
      `<div class="gs-group">A message arrived</div><div class="gs-card"><div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">@sample_handle</span><span class="gs-row-sub">“hi” · just now</span></div><div class="gs-row-end">${btn("That's me", 'data-action="its-me" data-size="sm"', "primary")}${btn("Not me", 'data-size="sm"', "quiet")}</div></div></div>` +
      `<p class="gs-note">Until you confirm, nobody gets an answer here.</p>`;
    return { title: "Connect Telegram", back: "chat", body };
  }

  function pluginsSection() {
    const row = (id, name, sub, extra = "") =>
      `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">${name}</span><span class="gs-row-sub">${sub}</span></div><div class="gs-row-end">${extra}${sw(id, state.plugins[id], name, !state.admin)}</div></div>`;
    const done = state.done
      ? `<div class="gs-done" role="status">${ICON.check}<span class="gs-done-text">Web search is on.</span><button type="button" class="gs-link">Turn off</button></div>`
      : "";
    const body =
      readOnlyNote() +
      `<div class="gs-group">Clawtrate's</div><div class="gs-card">` +
      row("bots", "Clawtrate's tools for bots", "Installed by Clawtrate · 1.4.0") +
      row("voice", "Bot voice", "Installed by Clawtrate · 1.4.0") +
      row("rules", "Tool rules", "Installed by Clawtrate · 1.4.0") +
      `</div><div class="gs-group">On your OpenClaw</div><div class="gs-card">` +
      row("search", "Web search", "Comes with OpenClaw", btn("Settings", 'data-size="sm"', "quiet")) +
      `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">Calendar sync</span><span class="gs-row-sub">Added on the gateway · 0.9.2</span></div><div class="gs-row-end">${btn("Settings", 'data-size="sm"', "quiet")}${sw("cal", true, "Calendar sync", !state.admin)}</div></div>` +
      `</div>${done}`;
    return { title: "Plugins", body };
  }

  function allSection() {
    const err = state.error;
    const field = (o) =>
      `<div class="gs-row"><div class="gs-row-main"><span class="gs-row-title">${o.label} ${info(o.id, o.asks ? `${o.help} A bot asks you before it changes this.` : o.help, o.path)}${o.restarts ? restartTag : ""}</span>${o.sub ? `<span class="gs-row-sub">${o.sub}</span>` : ""}${o.error ? `<p class="gs-error" id="err-${o.id}">${o.error}</p>` : ""}</div><div class="gs-row-end">${o.control}</div></div>`;
    const rows = [
      field({
        id: "bind",
        label: "Who can reach OpenClaw",
        help: "Which networks can connect to your OpenClaw. This computer only is the safest.",
        path: "gateway.bind",
        restarts: true,
        asks: true,
        control: `<label class="visually-hidden" for="gs-bind">Who can reach OpenClaw</label><select class="gs-select" id="gs-bind"${state.admin ? "" : " disabled"}><option${state.pending ? "" : " selected"}>This computer only</option><option${state.pending ? " selected" : ""}>Your private network (Tailscale)</option><option>Your local network</option></select>`,
      }),
      field({
        id: "port",
        label: "Port",
        help: "The number other devices use to reach OpenClaw on this computer.",
        path: "gateway.port",
        restarts: true,
        asks: true,
        error: err ? "Use a number from 1 to 65535. Nothing was changed." : "",
        control: `<label class="visually-hidden" for="gs-port">Port</label><input class="gs-input" id="gs-port" inputmode="numeric" style="width:110px" value="${err ? "700000" : state.pending ? "18800" : "18790"}"${err ? ' aria-invalid="true" aria-describedby="err-port"' : ""}${state.admin ? "" : " readonly"} />`,
      }),
      field({
        id: "token",
        label: "Sign-in token",
        help: "What older apps and the command line use to sign in to OpenClaw. Clawtrate doesn't need it.",
        path: "gateway.auth.token",
        asks: true,
        // Write-only: "Set" or "Not set", never the value; no Replace without full control.
        control: `<span class="gs-secret">${ICON.lock}Set</span>${state.admin ? btn("Replace", 'data-size="sm"', "quiet") : ""}`,
      }),
      field({
        id: "mdns",
        label: "Show OpenClaw to nearby devices",
        help: "Lets apps on your network find OpenClaw without typing its address.",
        path: "discovery.mdns.mode",
        asks: true,
        control: sw("mdns", false, "Show OpenClaw to nearby devices", !state.admin),
      }),
    ];
    const tray = state.pending
      ? `<div class="gs-tray" role="status"><span class="gs-tray-text"><strong>2 changes</strong> · ${restartWords()}</span>${btn("Discard", 'data-size="sm"', "quiet")}${btn("Save and restart", 'data-size="sm"', "primary")}</div>`
      : "";
    const body =
      readOnlyNote() +
      `<label class="gs-search">${ICON.search}<span class="visually-hidden">Search OpenClaw's settings</span><input type="search" value="${esc(state.q)}" placeholder="Search OpenClaw's settings" /></label>` +
      `<div class="gs-group">Gateway · 4 of 212 settings</div><div class="gs-card">${rows.join("")}</div>` +
      `<p class="gs-note">Settings Clawtrate shows elsewhere open there: <button type="button" class="gs-link" data-nav="models">Models</button>, <button type="button" class="gs-link" data-nav="chat">Chat apps</button>, <button type="button" class="gs-link" data-nav="plugins">Plugins</button>.</p>`;
    return { title: "All OpenClaw settings", body, foot: tray };
  }

  // What running work does during a restart, by version (gateway-settings.md section 7).
  const restartWords = () =>
    ({
      1006: "Saving restarts OpenClaw once its bots finish what they're doing, which can take up to 5 minutes.",
      unknown: "Saving restarts OpenClaw. Work running now may be interrupted.",
    })[state.version] ||
    "Saving restarts OpenClaw. Conversations pick up where they left off; tasks a bot started stop and may need starting again.";

  // ---- the conversation: a bot changing a setting when asked ---------------------

  // A bot never applies a setting by itself: every proposal is one card (gateway-settings.md section 8).
  function card(lines, note, primary, state_) {
    const done = state_ ? `<p class="gs-card-state">${state_}</p>` : "";
    const buttons = state_ ? "" : `<div class="gs-actions">${btn(primary, 'data-size="sm"', "primary")}${btn("Keep", 'data-size="sm"', "quiet")}</div>`;
    return (
      `<div class="gs-ask" role="group" aria-label="Juniper proposes a change">` +
      lines.map((l) => `<p class="gs-change">${l}</p>`).join("") +
      (note ? `<p>${note}</p>` : "") +
      `<p class="gs-quiet">You'll see what OpenClaw changed after you press.</p>${buttons}${done}</div>`
    );
  }

  function botView() {
    const t =
      `<div class="gs-msg-you">Make Swift 2 the default for everyone</div>` +
      `<div class="gs-msg-bot">Here it is. Press Change and every bot without a model of its own uses Swift 2.</div>` +
      card(["<strong>Default model:</strong> Swift 1 → Swift 2, on Work"], "", "Change", "Changed") +
      `<div class="gs-line" role="status">${ICON.check}Default model is now Swift 2, on Work · <button type="button" class="gs-link">Put back Swift 1</button></div>` +
      `<div class="gs-msg-you">And let my laptop reach you over Tailscale</div>` +
      card(
        ["<strong>Who can reach OpenClaw:</strong> This computer only → Your private network (Tailscale)"],
        `Devices on your Tailscale network could then connect, with a token or an approved device. ${restartWords()}`,
        "Change and restart",
      );
    root.innerHTML =
      banner() +
      `<div class="gs-chat"><div class="gs-chat-head"><span class="gs-avatar" aria-hidden="true">J</span>Juniper</div>` +
      `<div class="gs-transcript" aria-label="Conversation with Juniper">${t}</div>` +
      `<div class="gs-composer"><div>Message Juniper</div></div></div>`;
  }

  function banner() {
    return state.restart
      ? `<div class="gs-banner" role="status"><span class="gs-spin" aria-hidden="true"></span><span>OpenClaw is restarting to apply <strong>Who can reach OpenClaw</strong>. ${restartWords().replace(/^Saving restarts OpenClaw\.? ?/, "")}</span></div>`
      : "";
  }

  // ---- drawing ---------------------------------------------------------------

  function render() {
    const narrow = root.getBoundingClientRect().width < 640;
    root.dataset.narrow = narrow ? "1" : "0";
    if (state.screen === "bot") return botView();
    // The section list on its own: what Back leads to at phone width.
    if (state.screen === "list" && !narrow) state.screen = "models";
    const views = { models: modelsSection, chat: chatSection, telegram: telegramSection, pair: pairSection, plugins: pluginsSection, all: allSection };
    // Sections as built today: this design doesn't change them, so the prototype says so instead of drawing them.
    const unchanged = (id) => () => ({
      title: NAV.find(([n]) => n === id)[1],
      body: `<p class="gs-note" style="margin-top:12px">As built today. This design doesn't change this section.</p>`,
    });
    for (const [id] of NAV) if (!views[id]) views[id] = unchanged(id);
    const list = state.screen === "list";
    const view = list ? { title: "", body: "" } : (views[state.screen] || modelsSection)();
    const current = navFor(state.screen);
    const nav =
      `<nav class="gs-nav" aria-label="Settings"><h2 tabindex="-1">Settings</h2>` +
      NAV.map(([id, label]) => `<button type="button" class="gs-nav-item" data-nav="${id}"${id === current ? ' aria-current="page"' : ""}>${label}</button>`).join("") +
      `</nav>`;
    const backTo = view.back || "list";
    root.innerHTML =
      banner() +
      `<div class="gs-settings"${list ? ' data-list="1"' : ""}>${nav}<section class="gs-section" aria-labelledby="gs-title">` +
      `<header class="gs-head"><button type="button" class="gs-back" aria-label="Back" data-nav="${backTo}">${ICON.back}</button><h3 id="gs-title" tabindex="-1">${view.title}</h3></header>` +
      `<div class="gs-body">${view.body}</div>${view.foot ? `<footer class="gs-foot">${view.foot}</footer>` : ""}</section></div>`;
  }

  function go(screen) {
    if (!screen) return;
    state.screen = screen;
    state.done = false;
    state.tip = null;
    render();
    (state.screen === "list" ? root.querySelector(".gs-nav h2") : root.querySelector("#gs-title"))?.focus();
  }

  root.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.tip) {
      state.tip = state.tip === t.dataset.tip ? null : t.dataset.tip;
      render();
      root.querySelector(`[data-tip="${t.dataset.tip}"]`)?.focus();
      return;
    }
    if (t.dataset.nav) return go(t.dataset.nav);
    if (t.dataset.app === "telegram") return go("telegram");
    if (t.dataset.action === "to-pair") return go("pair");
    if (t.dataset.action === "its-me") {
      // The stand-in read-back: pairing on and only that sender let in, so "only you" is true.
      state.telegram = true;
      state.screen = "chat";
      state.done = true;
      state.tip = null;
      render();
      root.querySelector("#gs-title")?.focus();
      say("Telegram is connected. Only you can message Juniper there.");
      return;
    }
    if (t.dataset.action === "undo-model") {
      state.model = state.undoModel;
      state.done = false;
      render();
      say(`Default model is back to ${model(state.model).name}.`);
      root.querySelector("#gs-default")?.focus();
      return;
    }
    if (t.dataset.switch && !t.disabled) {
      const id = t.dataset.switch;
      if (id in state.plugins) state.plugins[id] = !state.plugins[id];
      state.done = id === "search" && state.plugins.search;
      render();
      root.querySelector(`[data-switch="${id}"]`)?.focus();
    }
  });

  root.addEventListener("change", (e) => {
    if (e.target.dataset.change === "model") {
      state.undoModel = state.model;
      state.model = e.target.value;
      state.done = true;
      render();
      say(`Default model is now ${model(state.model).name}.`);
      root.querySelector("#gs-default")?.focus();
    }
  });

  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.tip) {
      const id = state.tip;
      state.tip = null;
      render();
      root.querySelector(`[data-tip="${id}"]`)?.focus();
    }
  });

  document.addEventListener("ct:settings", render);
  addEventListener("resize", render);
  render();
})();
