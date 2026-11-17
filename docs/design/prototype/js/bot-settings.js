// A bot's settings, in the Work pane's Settings tab (docs/design/bots.md,
// sections 8 to 14): its account, bound or locked, model and effort, tools that
// come with the account, and what the conversation and the rail show when a run
// was served by another account or failed on its own.
//
// More address parameters, on top of bots.js:
//   tab=settings&panel=open   the bot's Settings tab, open (bot=<id> picks the bot)
//   bview=account|change       a page inside the tab
//   lock=watching|locked|stale the lock's state for the open bot
//   served=1                   Marlow's last run was served by another account
//   fail=quota|signedout       Otto's last run failed on its account
//   differs=1                  Pip's model has fallbacks on the gateway
//   bstate=loading|error       the tab while it loads, or when it could not
//   running=1                  the open bot has a run in progress

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { binding, MODELS, EFFORTS, acct, acctName, providerName, stateOf, kindWord, isAdmin, adminBar, button, note, copy, glyph, announce } = D;

  const panel = $("#panel-settings");
  const S = { view: p("bview") || "main", bot: null, pick: null, pickModel: null, seconds: 4, state: p("bstate") || "ready" };
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const current = () => app.model.selectedBot;
  // The gateway's side, which the page only reads: each bot's stored order, and
  // whether a read fails. The prototype bar changes it, as a person on the
  // gateway's machine would.
  const GW = { order: { otto: ["openai:work"] }, fail: false };
  let minute = 41;
  const clock = () => `5:${String(minute++).padStart(2, "0")} PM`;
  binding.otto.evidence = { state: "matched", at: "5:41 PM", lastMatch: "5:41 PM" };
  const lockFixture = p("lock");
  const sel = app.model.selectedBot;
  if (lockFixture && binding[sel]?.account) {
    const b = binding[sel];
    const a = acct(b.account);
    const other = D.accounts().find((x) => x.provider === a.provider && x.id !== a.id && !x.owner);
    if (lockFixture === "locked") Object.assign(GW.order, { [sel]: [a.id] }) && (b.evidence = { state: "matched", at: "5:41 PM", lastMatch: "5:41 PM" });
    if (lockFixture === "watching") Object.assign(b, { watching: true, evidence: { state: "nomatch", at: "5:40 PM" } }) && delete GW.order[sel];
    if (lockFixture === "stale") (GW.order[sel] = [other.id]) && (b.evidence = { state: "stale", at: "5:41 PM", lastMatch: "5:39 PM" });
    if (lockFixture === "gone") delete GW.order[sel], (b.evidence = { state: "gone", at: "5:52 PM", lastMatch: "5:41 PM" });
    if (lockFixture === "readfail") (GW.fail = true), (GW.order[sel] = [a.id]), (b.evidence = { state: "failed", at: "5:52 PM", lastMatch: "5:41 PM" });
    if (lockFixture === "old") (GW.order[sel] = [a.id]), (b.evidence = { state: "old", at: "5:41 PM", lastMatch: "5:41 PM" }), app.setConnection("reconnecting");
    if (lockFixture === "multi") (GW.order[sel] = [a.id, other.id]), (b.evidence = { state: "multi", at: "5:41 PM" });
    if (lockFixture === "bound") delete GW.order[sel], (b.evidence = { state: "nomatch", at: "5:40 PM" });
  }
  // What the page shows comes only from its last read of the gateway's order.
  const lockState = (id) => {
    const e = binding[id]?.evidence;
    if (!e) return "unread";
    if (e.state === "matched") return "locked";
    if ((e.state === "failed" || e.state === "old") && e.lastMatch) return "locked-asof";
    if (e.state === "stale") return "stale";
    return "bound";
  };
  function readOrder(id, reason) {
    const b = binding[id];
    if (!b?.account) return;
    const before = lockState(id);
    const e = b.evidence || {};
    // With the connection down nothing is read: the last check stands, marked old.
    if (app.model.connection !== "connected") {
      if (e.at) b.evidence = { ...e, state: e.state === "matched" || e.state === "old" ? "old" : e.state };
      if (reason !== "silent") render();
      return;
    }
    const at = clock();
    if (GW.fail) b.evidence = { state: "failed", at, lastMatch: e.lastMatch };
    else {
      const order = GW.order[id];
      const a = acct(b.account);
      if (order && order.length === 1 && order[0] === a.id) b.evidence = { state: "matched", at, lastMatch: at };
      else if (order && order.length === 1 && acct(order[0])?.provider === a.provider) b.evidence = { state: "stale", at, lastMatch: e.lastMatch };
      else if (order && order.includes(a.id)) b.evidence = { state: "multi", at };
      else if (e.state === "matched" || e.state === "gone" || e.state === "old") b.evidence = { state: "gone", at: e.state === "gone" ? e.at : at, lastMatch: e.lastMatch };
      else b.evidence = { state: "nomatch", at, lastMatch: e.lastMatch };
    }
    const after = lockState(id);
    if (after === "locked") b.watching = false;
    if (before !== after) {
      if (after === "locked") announce("Locked. The gateway confirmed it.");
      if (before === "locked" && after === "bound") announce(`${botName(id)} is no longer locked`);
    }
    if (reason !== "silent") render();
  }
  if (p("differs")) binding.pip.fallbacks = ["anthropic/claude-sonnet-5.5"];
  if (p("running")) binding[app.model.selectedBot] && (binding[app.model.selectedBot].running = true);
  if (p("long")) acct("openai:home").label = "Shared family plan for the whole house";

  // The tools an account brings, from the gateway's tool list under the provider's plugin.
  const PROVIDER_TOOLS = { xai: [["Search posts on X", "x_search"], ["Run code", "code_execution"]] };

  // The commands a person runs on the gateway's machine for a lock.
  const lockCommand = (bot, a) => `openclaw models auth order set --provider ${a.provider} --agent ${bot} ${a.id}`;
  const unlockCommand = (bot, a) => `openclaw models auth order clear --provider ${a.provider} --agent ${bot}`;

  // A command breaks only between its words, never inside a flag.
  const cmd = (text) => text.split(" ").map((t) => `<span class="b-tok">${esc(t)}</span>`).join(" ");
  CT.botsCmd = cmd;

  const sub = (title, backTo) =>
    `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="${backTo}" aria-label="Back to ${backTo === "main" ? "settings" : "account"}">${icon("back")}</button>` +
    `<h3 tabindex="-1" data-bs-focus>${title}</h3></div>`;
  const row = (label, value, attrs = "") =>
    attrs
      ? `<div><button type="button" class="b-open" ${attrs}><span>${label}</span><span class="b-open-value">${value}</span>${icon("chevron")}</button></div>`
      : `<div><dt>${label}</dt><dd>${value}</dd></div>`;

  function lockWord(id) {
    const b = binding[id];
    if (!b.account) return b.removed ? `<span class="b-state" data-tone="warn">${icon("warning")}No account</span>` : `<span class="b-state">Gateway chooses</span>`;
    const s = lockState(id);
    if (s === "locked") return `<span class="b-state">${icon("lock")}Locked</span>`;
    if (s === "locked-asof") return `<span class="b-state">${icon("lock")}Locked, as of ${b.evidence.lastMatch}</span>`;
    if (s === "stale") return `<span class="b-state" data-tone="warn">${icon("warning")}Lock out of date</span>`;
    return `<span class="b-state">Bound</span>`;
  }

  // The tab ---------------------------------------------------------------------------------------

  function render(focus) {
    const id = current();
    if (!id || !binding[id]) {
      panel.innerHTML = `<p class="work-note">This bot's settings are not part of this prototype.</p>`;
      return;
    }
    if (S.bot !== id) {
      S.bot = id;
      if (!p("bview") || S.seen) S.view = "main";
      S.pick = null;
    }
    S.seen = true;
    let html;
    if (S.state === "loading")
      html = `<div aria-busy="true" aria-label="Loading settings"><div class="skeleton" style="height:42px;width:100%;margin-top:18px"></div><div class="skeleton" style="height:96px;width:100%"></div><div class="skeleton" style="height:52px;width:100%"></div></div>`;
    else if (S.state === "error")
      html = `<div class="work-empty"><span class="empty-mark">${icon("warning")}</span><h4>Couldn't load ${esc(botName(id))}'s settings</h4><p>The gateway did not answer.</p><div style="margin-top:10px">${button("Try again", 'data-bs="reload" data-size="sm"')}</div></div>`;
    else html = S.view === "account" ? accountView(id) : S.view === "change" ? changeView(id) : (CT.botsT3View && S.view === "t3" ? CT.botsT3View(id) : mainView(id));
    const paint = () => {
      panel.innerHTML = html + (isAdmin() || S.state !== "ready" ? "" : `<div class="b-panel-foot">${adminBar(`Changing ${esc(botName(id))}'s settings needs admin access.`)}</div>`);
      CT.hydrate(panel);
    };
    // A re-render keeps focus where it was; a change of page moves it on purpose:
    // to the page's title, or back to the row that opened the page.
    if (!focus) return CT.botsKeep(panel, paint);
    paint();
    CT.botsRove(panel);
    const back = S.view === "main" && S.from ? $(`[data-bs="${S.from}"]`, panel) : null;
    requestAnimationFrame(() => (back || $("[data-bs-focus]", panel))?.focus());
  }

  function mainView(id) {
    const b = binding[id];
    const a = acct(b.account);
    const name = esc(botName(id));
    const provider = a ? a.provider : b.mode === "gateway" ? D.DEFAULT_MODEL.provider : null;
    const tools = (PROVIDER_TOOLS[provider] || []).map(([label]) => row(label, "Allowed")).join("");
    return (
      `<h3 class="b-tabgroup">About</h3><dl class="facts">` +
      row("Description", `<span class="b-faint">None</span>`) +
      row("Instructions", "From AGENTS.md, 42 lines") +
      `</dl>` +
      `<h3 class="b-tabgroup">Model</h3><dl class="facts">` +
      row("Account", `<span>${a ? esc(acctName(a)) : b.removed ? "" : esc(providerName(provider || D.DEFAULT_MODEL.provider))}</span>${lockWord(id)}`, `data-bs="account" aria-label="Account: ${a ? esc(acctName(a)) + ", " + lockState(id) : b.removed ? "no account" : "the gateway chooses"}. Open."`) +
      `</dl>` +
      (a || b.mode === "gateway"
        ? `<div class="b-pair" style="margin-top:8px">${D.select("model", "Model", b.model || D.DEFAULT_MODEL.model)}${D.select("effort", "Effort", b.effort)}</div>` +
          `<p class="b-hint">${esc(providerName(provider || D.DEFAULT_MODEL.provider))}'s models, as the gateway lists them. Which ones ${a ? "this account" : "an account"} may use is ${esc(providerName(provider || D.DEFAULT_MODEL.provider))}'s decision.</p>`
        : "") +
      (b.served ? note(`<p>${name}'s last run was finished on another ${esc(providerName(provider))} account. See Account.</p>`, "warn") : "") +
      (b.failed ? note(`<p>${b.failed}</p>`, "danger") : "") +
      `<h3 class="b-tabgroup">Tools</h3><dl class="facts">` +
      row("Permissions", "Ask before running commands") +
      `</dl>` +
      (tools
        ? `<h4 class="b-group">With ${esc(providerName(provider))}</h4><dl class="facts">${tools}</dl>` +
          `<p class="b-hint">These come with ${esc(providerName(provider))} accounts, while ${name} runs on ${esc(providerName(provider))}. ${esc(providerName(provider))} bills them per call.</p>`
        : "") +
      (CT.botsT3Row ? CT.botsT3Row(id) : "") +
      `<h3 class="b-tabgroup">Runs on</h3><dl class="facts">${row("Machine", "Gateway host")}</dl>`
    );
  }

  function accountView(id) {
    const b = binding[id];
    const a = acct(b.account);
    const name = esc(botName(id));
    const s = lockState(id);
    let html = sub("Account", "main");
    if (!a) {
      const who = esc(providerName(D.DEFAULT_MODEL.provider));
      html += b.removed
        ? note(`<p><b>No account.</b> ${name}'s account was disconnected. Clawtrate won't start ${name} until you choose one.</p>`, "warn")
        : note(`<p><b>The gateway chooses.</b> ${name} has no fixed account: the gateway picks one of ${who}'s accounts for each run, so its runs can use any of them. ${name} keeps its own model and no fallbacks.</p>`, "", icon("approval"));
      return html + (isAdmin() ? `<div class="b-actions" style="margin-top:14px">${button(b.removed ? "Choose an account" : "Bind to an account", 'data-bs="change" data-size="sm"', "primary")}</div>` : "");
    }
    const [tone, word] = stateOf(a);
    html +=
      `<dl class="facts">${row("Account", esc(acctName(a)))}${row("Kind", kindWord(a))}` +
      row("State", `<span class="b-state"${tone ? ` data-tone="${tone}"` : ' data-tone="ok"'}>${icon(tone ? "warning" : "check")}${word}</span>`) +
      `</dl>`;
    const other = D.accounts().filter((x) => x.provider === a.provider && x.id !== a.id);
    const who = esc(providerName(a.provider));
    const e = b.evidence || { state: "checking" };
    const evidence = {
      checking: `<p class="b-wait" role="status" style="margin:0"><span class="status-dot" data-status="connecting"></span>Checking the gateway's order for ${name}…</p>`,
      matched: `<p class="b-hint" role="status" style="margin:0">Checked with the gateway at ${e.at}.</p>`,
      nomatch: b.watching
        ? `<p class="b-wait" role="status" style="margin:0"><span class="status-dot" data-status="connecting"></span>Checking the gateway for the lock, again in ${S.seconds}s</p>`
        : `<p class="b-hint" role="status" style="margin:0">Not locked. Checked at ${e.at}.</p>`,
      multi: `<p class="b-hint" role="status" style="margin:0">The gateway's order for ${name} lists ${esc(acctName(a))} and 1 more account, so it is not a lock.</p>`,
      gone: "",
      failed: "",
      old: `<p class="b-hint" role="status" style="margin:0">Last checked at ${e.at}. Clawtrate checks again when it reconnects.</p>`,
      stale: `<p class="b-hint" role="status" style="margin:0">Checked with the gateway at ${e.at}.</p>`,
    }[e.state];
    const evidenceRow = `<div class="b-actions b-lockwait">${evidence}${button("Check now", 'data-bs="lock-check" data-size="sm"')}</div>`;
    const warnings =
      (e.state === "gone" ? note(`<p>The lock is gone: the gateway's order for ${name} changed at or before ${e.at}.</p>`, "warn") : "") +
      (e.state === "failed"
        ? note(`<p>Couldn't read the gateway's order for ${name}. ${e.lastMatch ? `Last confirmed locked at ${e.lastMatch}.` : "Never confirmed."}</p>`, "warn")
        : "");
    const unlock =
      `<details class="b-disclosure"><summary>${icon("chevron")}Unlock</summary><div class="b-disclosure-body"><p class="b-hint" style="margin-top:4px">Run this on the gateway's machine. Clawtrate sees the change by itself. ${name} then follows the gateway's other orders.</p>` +
      `<div class="command-line"><code>${cmd(unlockCommand(id, a))}</code>${copy("unlock command", unlockCommand(id, a))}</div></div></details>`;
    if (s === "locked" || s === "locked-asof") {
      html +=
        note(
          `<p><b>Locked${s === "locked-asof" ? `, as of ${e.lastMatch}` : ""}.</b> ${name}'s ordinary runs use ${esc(acctName(a))} only: if it fails, the run fails and says why, and the gateway doesn't try another account. A run started with another account named still goes round it.</p>`,
          "",
          icon("lock"),
        ) +
        warnings +
        evidenceRow +
        unlock;
    } else if (s === "stale") {
      const old = acct(GW.order[id]?.[0]) || acct(b.lockedTo);
      html +=
        note(`<p><b>The lock is out of date.</b> ${name} runs on ${esc(acctName(a))} first, but the gateway's order for ${name} still lists only ${esc(acctName(old))}, so when ${esc(acctName(a))} fails the gateway tries ${esc(acctName(old))}.</p>`, "warn") +
        `<h4 class="b-group">Lock to ${esc(acctName(a))}</h4>` +
        `<p class="b-step">Run this on the gateway's machine:</p>` +
        `<div class="command-line"><code>${cmd(lockCommand(id, a))}</code>${copy("lock command", lockCommand(id, a))}</div>` +
        evidenceRow +
        unlock;
    } else {
      html +=
        note(`<p><b>Bound.</b> ${name} runs on ${esc(acctName(a))}. If that account fails, the gateway may use ${other.length ? `another ${who} account, such as ${esc(acctName(other[0]))},` : `another ${who} account, if one is added,`} for that run.</p>`, "", icon("approval")) +
        warnings +
        `<h4 class="b-group">Lock to this account</h4>` +
        `<p class="b-step">Clawtrate can't set the lock itself; only the gateway's command line can. Run this on the gateway's machine:</p>` +
        `<div class="command-line"><code>${cmd(lockCommand(id, a))}</code>${copy("lock command", lockCommand(id, a))}</div>` +
        evidenceRow +
        `<p class="b-hint">What this cannot see: if ${esc(acctName(a))} is pausing after a failure, a run can start on another ${who} account without leaving a record Clawtrate can read.</p>`;
    }
    html +=
      `<details class="b-disclosure"><summary>${icon("chevron")}What a lock doesn't cover</summary><div class="b-disclosure-body"><ul class="b-list">` +
      `<li>A task or conversation set to another account, by another app or with the model command in chat. Clawtrate never does this.</li>` +
      `<li>A routine, or a helper bot, whose model names another account.</li>` +
      `<li>A message from another bot into a conversation that already uses another account.</li>` +
      `<li>A run that uses another model than ${name}'s own, set in a task or a routine: it doesn't carry ${name}'s account, so the gateway's own provider settings or order choose one.</li>` +
      `<li>A new ${who} sign-in on the gateway can add itself to the order. Clawtrate checks after every sign-in it starts.</li>` +
      `<li>Removing ${esc(acctName(a))}: the gateway then repairs the order to ${who}'s other accounts.</li>` +
      `<li>Commands run on the gateway's machine itself.</li>` +
      `<li>A lock is about accounts. An empty fallback list keeps ${name} off other models in the gateway's fallback list, but some providers can still switch the model inside a request.</li></ul></div></details>`;
    if (b.fallbackWriteFailed)
      html += note(
        `<p>Clawtrate couldn't write ${name}'s empty fallback list. ${name} has no fallbacks of its own, so nothing moves it to another model; the list only makes that explicit.</p>` +
          (isAdmin() ? `<div class="b-actions">${button("Try again", 'data-bs="write-fallbacks" data-size="sm"')}</div>` : ""),
      );
    if (b.fallbacks?.length)
      html += note(
        `<p><b>${name} can move to another model.</b> Its model on the gateway lists fallbacks (${esc(b.fallbacks.join(", "))}), so the gateway can move a run to them when this one fails.</p>` +
          (isAdmin() ? `<div class="b-actions">${button("Remove fallbacks", 'data-bs="no-fallbacks" data-size="sm"')}</div>` : ""),
        "warn",
      );
    if (b.served)
      html += note(`<p><b>Last run:</b> ${esc(acctName(a))} failed (${b.served.reason}) and the gateway finished the run on another ${who} account, at ${b.served.at}.</p>`, "", icon("clock"));
    if (isAdmin()) html += `<div class="b-actions" style="margin-top:18px">${button("Change account", 'data-bs="change" data-size="sm"')}</div>`;
    return html;
  }

  function changeView(id) {
    const b = binding[id];
    const name = esc(botName(id));
    const was = acct(b.account);
    const pick = acct(S.pick || b.account);
    let html =
      sub("Change account", "account") +
      `<p class="b-lead" style="text-align:left">Choose the account ${name} runs on.</p>` +
      D.accountGroups({ group: ` role="radiogroup" aria-label="Accounts for ${name}"`, row: (x) => D.accountRow(x, { choose: true, checked: pick && x.id === pick.id }) });
    let ready = Boolean(pick) && (!was || pick.id !== was.id);
    if (ready) {
      const needModel = !MODELS[pick.provider].includes(b.model);
      if (needModel) {
        html +=
          `<h4 class="b-group">Model</h4><div class="b-pair">${D.select("model", "Model", S.pickModel || "Choose")}${D.select("effort", "Effort", b.effort)}</div>` +
          `<p class="b-hint">${esc(providerName(pick.provider))} doesn't offer ${esc(b.model || "the current model")}. Choose one of its models.</p>`;
        if (!S.pickModel) ready = false;
      }
      if (b.running) html += note(`<p>A run in progress finishes on ${esc(acctName(was))}. The next run uses ${esc(acctName(pick))}.</p>`, "", icon("clock"));
      if (was && lockState(id) === "locked" && was.provider === pick.provider)
        html += note(`<p>${name} is locked to ${esc(acctName(was))}. After saving, ${name} runs on ${esc(acctName(pick))} first, and the gateway still tries ${esc(acctName(was))} when ${esc(acctName(pick))} fails, until you lock to ${esc(acctName(pick))} or unlock. Account then shows both commands.</p>`, "warn");
      const leaving = was && was.provider !== pick.provider ? PROVIDER_TOOLS[was.provider] : null;
      if (leaving) html += note(`<p>${leaving.map(([t]) => t).join(" and ")} come with ${esc(providerName(was.provider))} and leave ${name}'s tools.</p>`);
    }
    html += `<div class="b-actions" style="margin-top:16px">${button("Save", `data-bs="save-change" data-size="sm"${ready ? "" : " disabled"}`, "primary")}${button("Cancel", 'data-bs="account" data-size="sm"', "quiet")}</div>`;
    return html;
  }

  // The conversation's grey line for a change made here.
  function eventLine(botId, text) {
    const b = app.bots.find((x) => x.id === botId);
    const t = b.tasks.find((x) => x.id === app.model.selectedTask) || b.tasks[0];
    if (!t) return;
    if (t.html === undefined) t.html = ($("#transcript .transcript-inner")?.innerHTML || "").replace(/<h1 class="task-line">.*?<\/h1>/, "");
    t.html += `<div class="event-line" data-side="center">${esc(text)}</div>`;
    t.fresh = false;
  }

  // Fixtures in the conversation and the rail --------------------------------------------------------

  // Marlow's last run moved off its account: the gateway's log says the bound
  // account failed and the run went on; it does not say which account served it.
  if (p("served")) {
    binding.marlow.served = { reason: "rate limited", at: "4:58 PM" };
    const m = app.bots.find((b) => b.id === "marlow");
    // The row's warning stays until the person has seen the line in its task.
    if (app.model.selectedBot !== "marlow") m.notice = { text: "Used another account", tone: "warn", spoken: "used another account" };
    const raw = JSON.stringify({ event: "embedded_run_failover_decision", runId: "run_8c41f2", decision: "rotate_profile", failoverReason: "rate_limit", provider: "openai", model: "gpt-5.5", profileId: "sha256:4f1c0e9a2b7d" }, null, 2);
    m.tasks[0].html =
      `<div class="stamp">Today 4:57 PM</div>` +
      `<div class="turn" data-role="user" data-testid="transcript-turn"><div class="msg" data-role="user"><div class="bubble">Can you tighten the intro of the newsletter draft?</div></div></div>` +
      `<details class="event-details" data-testid="served-line"><summary class="event-line">OpenAI · Work failed (rate limited). The gateway finished this run on another OpenAI account, likely Home.${icon("chevron", "icon chevron")}</summary>` +
      `<div class="card event-body"><p class="b-p">The gateway's log for this run says it moved the run off OpenAI · Work after a rate limit. It doesn't say which account served the run.</p>` +
      `<p class="b-p"><b>Inferred:</b> OpenAI · Home is the only other OpenAI account, so it is likely. Clawtrate can't confirm it.</p>` +
      `<p class="b-p b-faint">Lock Marlow to OpenAI · Work, in its settings, to have a failure stop the run instead.</p>` +
      `<div class="b-actions">${button("Open Marlow's settings", 'data-bs="open-settings" data-bot="marlow" data-size="sm"')}<span class="spacer"></span>` +
      `<button type="button" class="button" data-variant="quiet" data-size="sm" data-bs="raw" aria-expanded="false">Raw</button></div>` +
      `<div class="b-raw" hidden><p class="code-label">The log record, as the gateway logs it</p><pre class="code-block"><code>${esc(raw)}</code></pre></div></div></details>` +
      `<div class="turn" data-role="assistant" data-testid="transcript-turn"><div class="msg" data-role="assistant"><div class="bubble md">Tightened the intro and cut about 80 words.</div></div></div>`;
  }

  // Otto's last run failed on its account: Otto is locked, so the gateway did not move it.
  const FAIL = {
    quota: {
      preview: "Couldn't finish: OpenAI · Work is out of quota",
      reason: "Otto's account, OpenAI · Work, is out of credit or quota: OpenAI refused the run. Otto is locked to it, so the gateway didn't use another account. The gateway pauses an account after a billing error, for 10 minutes at first.",
      actions: [["Change account", "change-account", "primary"], ["Try again", "retry-turn", ""]],
    },
    signedout: {
      preview: "Couldn't finish: sign in to OpenAI · Work again",
      reason: "Otto's account, OpenAI · Work, is signed out: OpenAI didn't accept its sign-in. Otto is locked to it, so the gateway didn't use another account.",
      actions: [["Sign in again", "sign-in-again", "primary"], ["Change account", "change-account", ""]],
    },
  };
  const fail = FAIL[p("fail")];
  if (fail) {
    const o = app.bots.find((b) => b.id === "otto");
    o.tasks.unshift({ id: "o0", title: "Check the UPS firmware", at: 1200, when: "now", preview: fail.preview, unread: false, status: "failed", html: "" });
    o.tasks[0].html =
      `<div class="stamp">Today 5:58 PM</div>` +
      `<div class="turn" data-role="user" data-testid="transcript-turn"><div class="msg" data-role="user"><div class="bubble">Is there a firmware update for the UPS?</div></div></div>` +
      `<div class="card turn-error" role="alert" data-testid="account-error">${icon("warning")}<p class="turn-error-title">Otto couldn't finish this turn</p>` +
      `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss this error">${icon("x")}</button>` +
      `<p class="turn-error-reason">${fail.reason}</p><div class="turn-error-actions">` +
      fail.actions.map(([label, action, variant]) => button(label, `data-bs="${action}" data-bot="otto" data-size="sm"`, variant)).join("") +
      `<span class="spacer"></span><button type="button" class="button" data-variant="quiet" data-size="sm" data-bs="copy-id">Copy request ID</button></div></div>`;
    o.notice = { text: fail.preview, tone: "danger", spoken: "a run failed on its account" };
    binding.otto.failed = (p("fail") === "quota" ? "Otto's last run failed: OpenAI · Work is out of quota. Change the account, or try again once the provider allows it." : "Otto's last run failed: OpenAI · Work is signed out. Sign in again, or change the account.");
    if (!p("bot")) app.openTask("otto", "o0");
  }
  if (p("served") || fail) app.selectBot(app.model.selectedBot);

  // Wiring ------------------------------------------------------------------------------------------

  // Opening a bot's task with the served line clears the warning on its row.
  document.addEventListener(
    "click",
    (event) => {
      const row = event.target.closest(".bot[data-bot], .task[data-task]");
      if (!row) return;
      const b = app.bots.find((x) => x.id === row.dataset.bot);
      if (b?.notice && b.notice.tone === "warn") delete b.notice;
    },
    true,
  );

  new MutationObserver(() => render()).observe($("#work-hero"), { childList: true });

  function openPanelSettings(botId, view) {
    if (app.model.selectedBot !== botId) app.selectBot(botId);
    S.view = view || "main";
    S.bot = botId;
    app.setPanel(true);
    $("#tab-settings").click();
    render(true);
  }
  CT.botsOpenSettings = openPanelSettings;

  panel.addEventListener("click", (event) => {
    const t = event.target;
    const id = current();
    const b = binding[id];
    // Copying the lock command is the sign the person is about to run it: the
    // page shows that it is watching, and reads more often. It proves nothing.
    if (t.closest('.copy[data-what="lock command"]') && lockState(id) !== "locked") {
      b.watching = true;
      S.seconds = 4;
      setTimeout(() => readOrder(id), 0);
      return;
    }
    const choose = t.closest("[data-b-choose]");
    if (choose) {
      if (!isAdmin()) return;
      S.pick = choose.dataset.bChoose;
      S.pickModel = null;
      render();
      $(`[data-b-choose="${S.pick}"]`, panel)?.focus();
      return;
    }
    const sel = t.closest("[data-b-select]");
    if (sel) {
      if (t.closest(".b-menu")) return;
      const which = sel.dataset.bSelect;
      const provider = S.view === "change" ? acct(S.pick).provider : acct(b.account)?.provider || "openai";
      const items = which === "model" ? MODELS[provider].map((m) => [m, ""]) : EFFORTS.map((e) => [e, ""]);
      const value = which === "model" ? (S.view === "change" ? S.pickModel : b.model) : b.effort;
      CT.botsSelect(sel, items, value, (v) => {
        if (which === "model" && S.view === "change") S.pickModel = v;
        else if (which === "model") b.model = v;
        else b.effort = v;
        render();
        $(`[data-b-select="${which}"]`, panel)?.focus();
        if (S.view === "main") announce(`${which === "model" ? "Model" : "Effort"} saved`);
      });
      return;
    }
    const raw = t.closest('[data-bs="raw"]');
    if (raw) return;
    const action = t.closest("[data-bs]")?.dataset.bs;
    if (!action) return;
    if (action === "main" || action === "account" || action === "change" || action === "t3") {
      if (S.view === "main" && action !== "main") S.from = action;
      if (action === "change") {
        S.pick = null;
        S.pickModel = null;
      }
      S.view = action;
      if (action === "account") readOrder(id, "silent"); // the page reads the order when it opens
      render(true);
    }
    if (action === "lock-check") {
      readOrder(id);
      $('[data-bs="lock-check"]', panel)?.focus();
    }
    if (action === "write-fallbacks") {
      b.fallbackWriteFailed = false;
      render(true);
      announce("Fallback list written");
    }
    if (action === "no-fallbacks") {
      b.fallbacks = [];
      render(true);
      announce("Fallbacks removed");
    }
    if (action === "save-change") {
      const was = acct(b.account);
      const pick = acct(S.pick);
      if (S.pickModel) b.model = S.pickModel;
      else if (!MODELS[pick.provider].includes(b.model)) b.model = MODELS[pick.provider][0];
      b.watching = false;
      b.account = pick.id;
      b.removed = false;
      b.inherits = false;
      delete b.served;
      delete b.failed;
      eventLine(id, `${botName(id)} now runs on ${acctName(pick)}${b.running && was ? `. The run in progress finishes on ${acctName(was)}.` : ", from the next run."}`);
      S.view = "account";
      S.pick = null;
      app.openTask(id, app.model.selectedTask);
      readOrder(id, "silent");
      render(true);
      announce(`${botName(id)} now runs on ${acctName(pick)}`);
    }
    if (action === "reload") {
      S.state = "ready";
      render(true);
    }
  });

  // The served line's Raw, and the failed turn's ways forward, live in the transcript.
  document.addEventListener("click", (event) => {
    const t = event.target.closest("#transcript [data-bs]");
    if (!t) return;
    const action = t.dataset.bs;
    if (action === "raw") {
      const box = t.closest(".event-body").querySelector(".b-raw");
      box.hidden = !box.hidden;
      t.setAttribute("aria-expanded", String(!box.hidden));
    }
    if (action === "open-settings") openPanelSettings(t.dataset.bot, "account");
    if (action === "change-account") openPanelSettings(t.dataset.bot, "change");
    if (action === "sign-in-again") {
      const a = acct(binding[t.dataset.bot].account);
      D.startConnect("settings");
      D.openSettings(t, "accounts");
      D.beginSignIn(D.OPTIONS.find((o) => o.provider === a.provider).id);
    }
    if (action === "retry-turn") announce("Trying again. This prototype has no gateway, so nothing runs.");
    if (action === "copy-id") announce("Copied request ID");
  });

  // While the Account page is open the page reads the order by itself: every 4
  // seconds once the command was copied, every 30 seconds otherwise.
  let tick = 0;
  setInterval(() => {
    const id = current();
    const b = binding[id];
    if (!b?.account || S.view !== "account" || panel.hidden || !panel.isConnected) return;
    tick += 1;
    if (b.watching && lockState(id) !== "locked") {
      S.seconds = S.seconds <= 1 ? 4 : S.seconds - 1;
      if (S.seconds === 4) return readOrder(id);
      const line = $(".b-lockwait .b-wait", panel);
      if (line) line.lastChild.textContent = `Checking the gateway for the lock, again in ${S.seconds}s`;
    } else if (tick % 30 === 0) readOrder(id);
  }, 1000);

  // Prototype controls: what a person on the gateway's machine would do.
  const extra = $("#proto-extra .run-controls");
  if (extra) {
    extra.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" data-gw="set">Gateway: lock set</button><button type="button" data-gw="clear">Gateway: lock cleared</button><button type="button" data-gw="fail">Gateway: order unreadable</button>`,
    );
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-gw]")?.dataset.gw;
      if (!what) return;
      const id = current();
      const a = acct(binding[id]?.account);
      if (what === "set" && a) GW.order[id] = [a.id];
      if (what === "clear") delete GW.order[id];
      if (what === "fail") GW.fail = !GW.fail;
    });
  }

  CT.botsChanged = () => render();
  CT.botsRender = render;
  window.botSettings = { S, GW, render, openPanelSettings, readOrder };

  $("#tab-settings").hidden = false;
  render();
  if (p("tab") === "settings" && p("panel") === "open") requestAnimationFrame(() => render());
})();
