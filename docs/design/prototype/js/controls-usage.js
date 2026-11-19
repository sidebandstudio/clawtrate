// Usage, budgets, where a bot runs, and machines (docs/design/controls.md,
// sections 14 to 17). Local fixtures only: no figure here came from a gateway.
// The budget and the totals read the same records, so they show the same number.

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const K = CT.ctl;
  const p = (name) => CT.params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const { esc, icon, sub, openRow, fact, skeleton, failed, mark, markWords } = K;
  const { isAdmin, adminBar, button, note, copy, announce, B } = D;
  const BS = window.botSettings;
  const panel = $("#panel-settings");
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const current = () => app.model.selectedBot;
  const fmt = (n) => n.toLocaleString("en-US");
  const short = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2).replace(/0$/, "").replace(/\.0$/, "")}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

  const USAGE = p("usage") || "";
  const BUDGET = p("budget") || "";
  const MACHINE = p("machine") || "";
  const U = { period: "week", form: BUDGET === "invalid" ? { value: "900", kind: "weekly" } : null };

  // This week's figures for each bot (usage.cost, sessions.usage). Otto's total is 1,640,000.
  const WEEK = {
    otto: { input: 322000, output: 51000, cacheRead: 1244900, cacheWrite: 22100, cost: 3.29, sources: [["Your messages", 1240000], ["Routines", 312000], ["Messages from other bots", 41200], ["Not attributed", 46800]] },
    juniper: { input: 498000, output: 91000, cacheRead: 1610000, cacheWrite: 40000, cost: 5.92, sources: [["Your messages", 2239000]] },
    marlow: { input: 120000, output: 31000, cacheRead: 402000, cacheWrite: 9000, cost: 1.1, sources: [["Your messages", 520000], ["Messages from other bots", 42000]] },
    pip: { input: 90000, output: 22000, cacheRead: 260000, cacheWrite: 7000, cost: 0.74, sources: [["Your messages", 379000]] },
  };
  const scale = { today: 0.18, week: 1, month: 3.6 };
  const fig = (bot, period = U.period) => {
    const w = WEEK[bot] || WEEK.pip;
    const k = scale[period];
    const r = (n) => Math.round(n * k);
    const total = r(w.input) + r(w.output) + r(w.cacheRead) + r(w.cacheWrite);
    return { input: r(w.input), output: r(w.output), cacheRead: r(w.cacheRead), cacheWrite: r(w.cacheWrite), total, cost: w.cost * k, sources: w.sources.map(([n, v]) => [n, r(v)]) };
  };
  const weekTotal = (bot) => fig(bot, "week").total;

  // Otto's budget: a warning, always (section 17). A Daily budget counts today's total, a Weekly one this week's.
  const limitFor = { warn: 2000000, reached: 1600000, daily: 400000 };
  const G = {
    otto: BUDGET === "none" ? null : { kind: BUDGET === "daily" ? "daily" : "weekly", limit: limitFor[BUDGET] || 2500000 },
    routine: { name: "Weekly cleanup", bot: "otto", kind: "daily", limit: 200000, used: 41000 },
  };
  const usedOf = (bot) => (G[bot]?.kind === "daily" ? fig(bot, "today").total : weekTotal(bot));
  const pctOf = (bot) => Math.round((usedOf(bot) / G[bot].limit) * 100);
  const periodWords = (g) => (g.kind === "daily" ? "today" : "this week");
  const kindWord = (g) => (g.kind === "daily" ? "daily" : "weekly");

  function meter(used, limit, words, label, right) {
    const pct = Math.min(100, Math.round((used / limit) * 100));
    const tone = used >= limit ? "danger" : pct >= 80 ? "warn" : "";
    return (
      `<div class="c-meter"${tone ? ` data-tone="${tone}"` : ""}><div class="c-meter-bar" role="meter" aria-valuemin="0" aria-valuemax="${limit}" aria-valuenow="${Math.min(used, limit)}" aria-label="${esc(label || words)}"><span style="width:${pct}%"></span></div>` +
      `<div class="c-meter-text"><span>${words}</span><span>${right ?? `${Math.round((used / limit) * 100)}%`}</span></div></div>`
    );
  }
  const periodSeg = () =>
    `<div class="seg" role="radiogroup" aria-label="Period" style="margin:4px 0 10px">${[
      ["today", "Today"],
      ["week", "This week"],
      ["month", "30 days"],
    ]
      .map(([v, l]) => `<button type="button" role="radio" aria-checked="${U.period === v}" tabindex="${U.period === v ? 0 : -1}" data-c="period" data-value="${v}">${l}</button>`)
      .join("")}</div>`;
  const bars = (rows) => {
    const max = Math.max(...rows.map(([, v]) => v), 1);
    return `<ul class="c-bars">${rows.map(([n, v]) => `<li><span>${esc(n)}</span><span class="c-meter-bar" aria-hidden="true"><span style="width:${Math.round((v / max) * 100)}%"></span></span><span>${short(v)} tokens</span></li>`).join("")}</ul>`;
  };

  // The Usage and Runs on groups in the bot's settings.
  const prevExtra = CT.botsExtraGroups;
  CT.botsExtraGroups = (id) => {
    const g = G[id];
    let value = USAGE === "error" ? "Couldn't load" : `This week: ${short(weekTotal(id))} tokens · ${USAGE === "nocost" ? "cost unavailable" : `about $${fig(id, "week").cost.toFixed(2)}${USAGE === "partial" ? ", partial" : ""}`}`;
    if (g) value = `Budget ${short(usedOf(id))} of ${short(g.limit)} ${periodWords(g)} · ${value}`;
    return (prevExtra ? prevExtra(id) : "") + `<h3 class="b-tabgroup">Usage</h3><dl class="facts">${openRow("Usage", value, `data-bs="usage" aria-label="Usage: ${value}. Open."`)}</dl>`;
  };
  CT.botsRunsOn = (id) => {
    const shared = MACHINE === "shared" || id === "pip";
    const where = id === "otto" && MACHINE !== "gatewayhost" ? "media-box" : "the gateway's machine";
    const value = `Commands on ${where}${shared ? ` · Shared with ${id === "pip" ? "Marlow" : "Pip"}` : ""}`;
    return openRow(`Where ${esc(botName(id))} runs`, value, `data-bs="machine" aria-label="Where ${esc(botName(id))} runs: ${value}. Open."`);
  };

  // A bot's usage (section 16), with its budget first (section 17).
  function usageView(bot) {
    const name = esc(botName(bot));
    let html = sub("Usage", "main", "Back to settings");
    if (USAGE === "loading") return html + skeleton(`Loading ${name}'s usage`, 4);
    if (USAGE === "error") return html + failed(`Couldn't load ${name}'s usage`, "usage-retry");
    html += budgetPart(bot);
    const f = fig(bot);
    html += `<h4 class="b-group">Usage</h4>` + periodSeg();
    html += `<p class="b-hint" style="margin-top:0">From the gateway's usage records for ${name}, as of 5:41 PM.${USAGE === "computing" ? " Some of today's runs are still being counted." : ""}</p>`;
    html +=
      `<dl class="facts">` +
      fact("Input", `${fmt(f.input)} tokens`) +
      fact("Output", `${fmt(f.output)} tokens`) +
      fact("Cache read", `${fmt(f.cacheRead)} tokens`) +
      fact("Cache write", USAGE === "computing" ? "Still being counted" : `${fmt(f.cacheWrite)} tokens`) +
      fact("Total", `${fmt(f.total)} tokens${USAGE === "computing" ? " so far" : ""}`) +
      fact("Cost", USAGE === "nocost" ? "Unavailable" : `About $${f.cost.toFixed(2)}${USAGE === "partial" ? " · Partial" : ""}`) +
      `</dl>` +
      `<p class="b-hint">${USAGE === "nocost" ? "Cost unavailable for scripted/dev-1: the gateway has no price for it." : `The gateway's estimate from its configured prices, in US dollars, as of 5:41 PM.${USAGE === "partial" ? " Partial: 2 runs have no price configured." : ""}`}</p>`;
    html += `<h4 class="b-group">By source</h4>${bars(f.sources)}<p class="b-hint">Routines: runs whose task is a routine's. Messages from other bots: runs a send's result names. The rest is not attributed, never charged to one message.</p>`;
    const tasks = app.bots.find((b) => b.id === bot).tasks.slice(0, 4);
    html += `<h4 class="b-group">By task</h4><dl class="facts">${tasks.map((t, i) => fact(esc(t.title), `${short(Math.round(f.total * [0.48, 0.22, 0.12, 0.05][i]))} tokens`)).join("")}</dl>`;
    html += `<h4 class="b-group">Context</h4><dl class="facts">${fact(`'${esc(tasks[0].title)}'`, "41,200 of 128,000 tokens")}</dl><p class="b-hint">What fills it isn't reported: the gateway counts input, output and cache, not history, memory or tools apart.</p>`;
    return html;
  }

  function budgetPart(bot) {
    const name = esc(botName(bot));
    const g = G[bot];
    let html = `<h4 class="b-group">Budget</h4>`;
    if (!g && !U.form)
      return html + `<p class="b-hint">No budget. A budget is a number of tokens ${name} may use in a day or a week. By default it is a warning.</p>` + (B.access !== "read" ? `<div class="b-actions">${button("Set a budget", 'data-c="budget-new" data-size="sm"')}</div>` : "");
    if (U.form) return html + budgetForm(bot);
    const used = usedOf(bot);
    const pct = pctOf(bot);
    html += meter(used, g.limit, `${short(used)} of ${short(g.limit)} tokens ${periodWords(g)}`, `${name}'s ${kindWord(g)} budget: ${fmt(used)} of ${fmt(g.limit)} tokens`);
    html += `<p class="c-sentence">${mark("shown")}</p>`;
    html += `<p class="b-hint">A warning: at 80% a line in ${name}'s task, at 100% a note above the composer. Other apps, channels and routines aren't stopped, and nothing on the gateway stops ${name} at the limit.</p>`;
    if (pct >= 100) html += note(`<p><b>${name} has reached its ${kindWord(g)} warning budget.</b> This is shown only: other apps, channels and ${name}'s routines aren't stopped.</p>`, "warn");
    else if (pct >= 80) html += note(`<p>${name} has used ${pct}% of its ${kindWord(g)} budget.</p>`, "warn");
    html += `<p class="b-hint">Counts the total the gateway reports ${periodWords(g)}: input, output and cache, the same figure as Usage below. ${g.kind === "daily" ? "Resets at 00:00" : "Resets Monday at 00:00"}, your time.</p>`;
    if (B.access !== "read") html += `<div class="b-actions">${button("Raise budget", 'data-c="budget-edit" data-size="sm"')}${pct >= 100 && isAdmin() ? button("Pause Weekly cleanup", 'data-c="pause-routine" data-size="sm"', "quiet") : ""}</div>`;
    if (pct >= 100 && isAdmin()) html += `<p class="b-hint">Pausing stops the routine itself, not the budget.</p>`;
    return html;
  }

  function budgetForm() {
    const f = U.form;
    const n = Number(f.value.replace(/[, ]/g, ""));
    const bad = !Number.isInteger(n) || n < 1000;
    return (
      `<div class="c-form" role="group" aria-label="Budget"><div class="seg" role="radiogroup" aria-label="Period">${[
        ["daily", "Daily"],
        ["weekly", "Weekly"],
      ]
        .map(([v, l]) => `<button type="button" role="radio" aria-checked="${f.kind === v}" tabindex="${f.kind === v ? 0 : -1}" data-c="budget-kind" data-value="${v}">${l}</button>`)
        .join("")}</div>` +
      `<label>Tokens<input class="input" inputmode="numeric" data-c-budget value="${esc(f.value)}" aria-describedby="c-budget-help${bad && f.value ? " c-budget-error" : ""}"${bad && f.value ? ' aria-invalid="true"' : ""} /></label>` +
      `<p class="b-hint" id="c-budget-help" style="margin:0">Counts the total the gateway reports ${f.kind === "daily" ? "each day" : "each week"}: input, output and cache. A warning: nothing on the gateway stops a bot at its budget.</p>` +
      (bad && f.value ? `<p class="b-field-error" id="c-budget-error" role="alert" style="margin:0">Enter a whole number of 1,000 or more.</p>` : "") +
      `<div class="b-actions">${button("Save budget", `data-c="budget-save" data-size="sm"${bad ? " disabled" : ""}`, "primary")}${button("Cancel", 'data-c="budget-cancel" data-size="sm"', "quiet")}</div></div>`
    );
  }

  // Where a bot runs (section 14): three places, and what its settings name.
  function machineView(bot) {
    const name = esc(botName(bot));
    const node = bot === "otto" && MACHINE !== "gatewayhost";
    const offline = MACHINE === "offline";
    const sharedWith = bot === "pip" ? "Marlow" : MACHINE === "shared" ? "Pip" : null;
    const dis = isAdmin() ? "" : " disabled";
    let html = sub(`Where ${name} runs`, "main", "Back to settings");
    if (sharedWith) html += note(`<p>${name} shares its workspace folder with ${sharedWith}. Files one bot writes, the other can change.</p>`, "warn");
    html +=
      `<h4 class="b-group">Commands</h4>` +
      `<label class="b-hint" for="c-machine" style="display:block;margin:0 0 6px">Configured to run ${name}'s commands on:</label>` +
      `<select class="input" id="c-machine" data-c-machine${dis}><option${node ? "" : " selected"}>The gateway's machine</option><option${node ? " selected" : ""}>media-box · ${offline ? "Not connected" : "Connected"}</option><option>studio-mac · Not connected</option></select>` +
      `<p class="c-sentence">A configured setting for ${name}. A task can be sent to another machine; where a command ran is in its own result. ${mark("gateway")}</p>` +
      (node && offline ? `<p class="b-hint">media-box isn't connected: Last seen 5:12 PM.</p>` : "");
    html +=
      `<h4 class="b-group">Workspace</h4><dl class="facts">` +
      fact("Configured folder", `<span class="mono">workspaces/${bot}</span>, on the gateway's machine${copy("folder", `workspaces/${bot}`)}`) +
      `</dl><p class="b-hint">Configured as the folder for ${name}'s file tools.${node ? " On media-box, commands run in media-box's own folder unless a task names one." : ""}</p>` +
      (isAdmin() ? `<div class="b-actions">${button("Change…", 'data-c="ws-change" data-size="sm"')}</div><p class="b-hint">Takes a path on the gateway's machine; the gateway creates it if it doesn't exist.</p>` : "");
    html +=
      `<h4 class="b-group">Browser</h4><dl class="facts">` +
      fact("Browser", MACHINE === "ownbrowser" ? `${name}'s own browser, on the gateway's machine (Clawtrate's computer plugin)` : "The gateway's shared browser, on the gateway's machine. Every bot that uses the browser shares it.") +
      `</dl><p class="b-hint">${node ? "Commands running on media-box don't change where the browser is." : "Where commands run doesn't change where the browser is."}</p>`;
    html +=
      `<h4 class="b-group">What ${name}'s settings name</h4><p class="b-hint" style="margin-top:0">Inventory. Whether ${name} can use each isn't reported.</p><dl class="facts">` +
      fact("Accounts", bot === "otto" ? "OpenAI · Work (bound), OpenAI · Home" : "As its account page lists them") +
      fact("Tool servers", "coder (offered in the latest task); t3code (denied for this bot)") +
      fact("Secrets", isAdmin() ? "Names in the gateway's secret store, shared by every bot: router-admin, nas-backup, camera-feed" : `<span class="b-faint">Needs admin access</span>`) +
      fact("Plugin sign-ins", isAdmin() ? "None" : `<span class="b-faint">Needs admin access</span>`) +
      fact("Folders", "Its workspace. File tools stay inside a task's folder in the guarded modes; commands reach whatever the machine's user can.") +
      `</dl>`;
    return html;
  }

  CT.botsPageViews = Object.assign(CT.botsPageViews || {}, { usage: usageView, machine: machineView });

  // Settings, Usage (sections 16 and 17).
  CT.botsSections.push(["usage", "Usage"]);
  CT.botsSectionViews.usage = ({ back }) => {
    if (USAGE === "error") return { title: "Usage", back, body: failed("Couldn't load usage", "usage-retry") };
    let body = `<h4 class="b-group">Provider limits</h4>`;
    body += USAGE === "nolimits" ? `<p class="b-hint">No limits reported.</p>` : meter(62, 100, "OpenAI · Weekly · 62% used · resets Nov 20 · as of 5:40 PM", "OpenAI's weekly limit: 62% used, as of 5:40 PM", "") + `<p class="b-hint">xAI: no limits reported. xAI reports a balance of $12.40, as of 5:38 PM. Neither says which of your accounts it is about.</p>`;
    body += `<h4 class="b-group">Budgets</h4><dl class="facts">`;
    const g = G.otto;
    if (g) body += `<div class="b-row"><span class="b-row-main"><span>Otto · ${kindWord(g)} · ${short(usedOf("otto"))} of ${short(g.limit)} tokens ${periodWords(g)}</span><small>${markWords("shown")}</small></span></div>`;
    body += `<div class="b-row"><span class="b-row-main"><span>Routine Weekly cleanup (Otto) · daily · ${short(G.routine.used)} of ${short(G.routine.limit)} tokens</span><small>${markWords("shown")}</small></span></div></dl>`;
    if (B.access !== "read") body += `<div class="b-actions" style="margin-top:8px">${button("Add a budget", 'data-c="budget-add" data-size="sm"')}</div>`;
    body += `<h4 class="b-group">By bot</h4>` + periodSeg() + `<p class="b-hint" style="margin-top:0">From the gateway's usage records, as of 5:41 PM.</p>${bars(app.bots.map((b) => [b.name, fig(b.id).total]))}`;
    return { title: "Usage", back, body };
  };

  // Settings, Machines (section 15).
  CT.botsSections.push(["machines", "Machines"]);
  const ALWAYS = p("override") === "1";
  CT.botsSectionViews.machines = ({ back }) => {
    const pairing = p("devices") !== "noscope";
    let body =
      `<h4 class="b-group">Machines</h4><dl class="facts">` +
      fact("The gateway's machine", "Connected · Bots configured to run commands here: Juniper, Marlow, Pip") +
      fact("media-box", `${MACHINE === "offline" ? "Not connected · Last seen 5:12 PM" : "Connected · Last seen 40 s ago"} · Bots configured to run commands here: Otto`) +
      fact("studio-mac", "Not connected · Last seen Nov 16, 11:02 PM · No bots") +
      `</dl>`;
    body += `<h4 class="b-group" id="c-approvals-label">media-box's approvals file</h4>`;
    if (!isAdmin()) body += `<p class="b-hint">Seeing a machine's approvals needs admin access.</p>`;
    else
      body +=
        `<p class="c-subgroup">Defaults, for bots with no entry of their own</p><dl class="facts" role="radiogroup" aria-labelledby="c-approvals-label">` +
        [
          ["always", "Ask every time"],
          ["miss", "Ask for commands not on the allowlist"],
          ["allow", "Allow every command"],
          ["never", "Never allow"],
        ]
          .map(([v, l]) => `<div><button type="button" class="b-open" role="radio" aria-checked="${v === "miss"}" tabindex="${v === "miss" ? 0 : -1}" data-c="node-approvals" data-value="${v}"><span>${l}</span>${v === "miss" ? icon("check") : ""}</button></div>`)
          .join("") +
        `</dl><p class="c-subgroup">Entries</p><dl class="facts">${fact("Otto", ALWAYS ? "Its own entry: Ask on every command" : "No entry: the defaults")}${fact("Pip", "No entry: the defaults")}</dl>` +
        `<p class="c-subgroup">Effective, for the bots configured for media-box</p><dl class="facts">${fact("Otto", ALWAYS ? "Every command asks: its entry here asks every time, so the gateway skips Otto's reviewer" : "Review first: commands on the allowlist run, and the reviewer decides the rest, because this file asks only for commands not on it, as Otto's policy does")}</dl>` +
        `<p class="b-hint">The gateway takes the stricter of a bot's policy and this file, and the more asking of the two; it uses a bot's reviewer only when this file doesn't ask more. "Allow every command" still meets each bot's own policy. ${mark("set")}</p>`;
    body += `<div class="b-actions">${button("Rename", `data-c="node-rename" data-size="sm"${pairing ? "" : " disabled"}`)}${button("Remove studio-mac…", `data-c="node-remove" data-size="sm"${pairing ? "" : " disabled"}`, "quiet")}</div>`;
    body += `<h4 class="b-group">Paired devices</h4>`;
    body += pairing ? `<dl class="facts">${fact("This device", "Clawtrate on this Mac · Connected")}${fact("Clawtrate on iPhone", "Last seen 4:58 PM")}</dl>` : `<p class="b-hint">Seeing paired devices needs device access.</p>`;
    const foot = !pairing
      ? `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Device access needed.</b> Managing paired devices needs device access.</span>${button("Request access", 'data-c="request-pairing" data-size="sm"', "primary")}</div></section>`
      : isAdmin()
        ? ""
        : adminBar("Setting a machine's approvals needs admin access.");
    return { title: "Machines", back, body, foot };
  };

  // In the conversation: budget lines and the provider note (sections 16 to 18).
  function composerNotes() {
    $$(".c-composer-note").forEach((n) => n.remove());
    const comp = $("#composer");
    if (!comp) return;
    const bot = current();
    const add = (html, tone) => {
      const d = document.createElement("div");
      d.className = "c-composer-note";
      if (tone) d.dataset.tone = tone;
      d.setAttribute("role", "status");
      d.innerHTML = html;
      comp.before(d);
    };
    const lim = p("plimit");
    if (lim === "near" && bot === "otto") add(`<p>OpenAI reports 92% of a weekly limit used, as of 5:40 PM. It doesn't say which of your OpenAI accounts.</p><button type="button" class="icon-button" data-variant="quiet" data-c="banner-close" aria-label="Close">${icon("x")}</button>`, "neutral");
    if (lim === "reached" && bot === "otto") add(`<p>OpenAI reports a weekly limit reached, as of 5:40 PM. It resets Nov 20.</p><button type="button" class="icon-button" data-variant="quiet" data-c="banner-close" aria-label="Close">${icon("x")}</button>`);
    const g = G[bot];
    if (bot === "otto" && g && pctOf(bot) >= 100) add(`<p>Otto has reached its ${kindWord(g)} warning budget. This is shown only: other apps, channels and Otto's routines aren't stopped.</p>${B.access !== "read" ? button("Raise budget", 'data-c="raise-from-composer" data-size="sm"') : ""}`);
  }
  const otto = app.bots.find((b) => b.id === "otto");
  if (BUDGET === "warn") {
    const t = otto.tasks.find((x) => x.id === "o3");
    t.html =
      `<div class="stamp">Today 5:58 PM</div>` +
      `<div class="turn" data-role="user"><div class="msg" data-role="user"><div class="bubble">Did last night's backup finish?</div></div></div>` +
      `<div class="event-line" data-side="center" data-testid="budget-line">Otto has used 82% of its weekly budget: 1.64M of 2M tokens.</div>`;
  }
  const diskTask = otto.tasks.find((x) => x.id === "o1");
  if (p("saveline") === "1" && diskTask && typeof diskTask.html === "string") diskTask.html += `<button type="button" class="event-line link-button" data-side="center" data-c="saved-to-memory" data-testid="memory-line">Saved to memory: memory/2026-11-17.md</button>`;
  if (BUDGET === "warn" || p("saveline") === "1") app.openTask(app.model.selectedBot, app.model.selectedTask);

  // Wiring ---------------------------------------------------------------------------------------

  document.addEventListener("click", (event) => {
    const t = event.target.closest("[data-c]");
    if (!t || t.disabled) return;
    const bot = current();
    switch (t.dataset.c) {
      case "period":
        U.period = t.dataset.value;
        return panel.contains(t) ? BS.render() : D.renderSettings();
      case "usage-retry":
        return BS.render();
      case "budget-new":
      case "budget-edit":
        if (B.access === "read") return;
        U.form = { value: G[bot] ? String(G[bot].limit) : "", kind: G[bot]?.kind || "weekly" };
        BS.render();
        return setTimeout(() => $("[data-c-budget]", panel)?.focus(), 30);
      case "budget-kind":
        U.form.kind = t.dataset.value;
        return BS.render();
      case "budget-cancel":
        U.form = null;
        return BS.render();
      case "budget-save": {
        if (B.access === "read") return;
        const n = Number(U.form.value.replace(/[, ]/g, ""));
        G[bot] = { kind: U.form.kind, limit: n };
        U.form = null;
        BS.render();
        composerNotes();
        return announce("Budget saved");
      }
      case "raise-from-composer":
        app.setPanel(true);
        BS.S.view = "usage";
        $("#tab-settings").click();
        if (B.access === "read") return;
        U.form = { value: "3000000", kind: G[bot]?.kind || "weekly" };
        return BS.render(true);
      case "pause-routine":
        return announce("Weekly cleanup is paused. Resume it from the routine's page.");
      case "banner-close":
        t.closest(".c-composer-note")?.remove();
        return announce("Closed");
      case "saved-to-memory":
        app.setPanel(true);
        BS.S.view = "memitem";
        if (window.controlsMemory) window.controlsMemory.X.item = "n1";
        $("#tab-settings").click();
        return BS.render(true);
      case "node-approvals":
        return;
      case "node-rename":
      case "node-remove":
      case "ws-change":
      case "budget-add":
        return announce("This opens its form here; the prototype stops at the button.");
      case "request-pairing":
        return announce("Asking the gateway for device access");
    }
  });
  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t.matches("[data-c-budget]") && U.form) {
      U.form.value = t.value;
      const pos = t.selectionStart;
      BS.render();
      const f = $("[data-c-budget]", panel);
      f?.focus();
      f?.setSelectionRange(pos, pos);
    }
  });

  new MutationObserver(() => {
    if (!$(".c-composer-note") || $(".c-composer-note").nextElementSibling?.id !== "composer") composerNotes();
  }).observe($("#composer"), { childList: true });
  document.addEventListener("click", (event) => {
    if (event.target.closest(".bot[data-bot], .task[data-task]")) setTimeout(composerNotes, 30);
  });
  composerNotes();

  window.controlsUsage = { U, G, composerNotes };
  BS.render();
  if ($("#settings-dialog").open) {
    D.renderSettings();
    D.focusFirst($("#settings-dialog"));
  }
})();
