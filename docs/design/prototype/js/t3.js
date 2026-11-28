// T3 Code, optional (docs/design/bots.md, sections 15 to 18): the switch in
// Settings, Integrations; adding a T3 Code server to the gateway and signing the
// gateway in to it; each bot's own switch and limits; turning it off.
// The switch is the person's own preference; the server and each bot's T3 Code
// are the gateway's, shared, and change only through admin actions.
//
// More address parameters:
//   t3=on                    the integration is on for this person (off by default)
//   t3server=none            no T3 Code server on the gateway yet (default: added)
//   t3obs=none|saved|worked|refused   what Clawtrate last observed of the gateway's sign-in
//   t3signin=starting|waiting|failed|expired|cancelled   the app-started sign-in's stage
//   t3origin=1               this connection can start the gateway's sign-in itself
//   t3listing=notconnected|stale   the gateway's cached tool listing for the bot
//   t3plugin=0               Clawtrate's gateway plugin is absent: no skill, no limits
//   t3found=1                a bot has the T3 Code tools without being turned on
//   t3withheld=1             a bot is turned on, but the gateway withholds the tools
//   t3catalog=loading|error  the limits page's lists from T3 Code
//   t3write=refused|timeout|partial   how the next gateway write ends
//   skilldef=1               the gateway has a default skill list without the T3 Code skill
//   skillread=fail           the read-back after enabling doesn't show the skill
//   skillchanged=1           the person changed a bot's list after Clawtrate wrote it
//   section=integrations     Settings on Integrations; bview=t3 a bot's T3 Code page

(function () {
  const CT = window.CT;
  const app = window.app;
  const D = CT.botsData;
  const params = CT.params;
  const p = (name) => params.get(name);
  const $ = (selector, root = document) => root.querySelector(selector);
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const { binding, isAdmin, adminBar, button, note, copy, announce, B } = D;
  const cmd = (text) => CT.botsCmd(text);

  const added = p("t3") === "on" && p("t3server") !== "none";
  const T = {
    on: p("t3") === "on",
    server: added ? "https://code.example.net" : null,
    address: "",
    error: "",
    write: null, // the outcome of the last gateway write: refused, checking, partial
    stage: p("t3signin") || null, // the app-started sign-in
    observed: added ? p("t3obs") || "worked" : "none",
    origin: p("t3origin") === "1",
    plugin: p("t3plugin") !== "0",
    listing: p("t3listing") || "listed",
    copied: false,
    catalog: p("t3catalog") || "ready",
    stillOn: null,
  };
  if (added) binding.otto.t3 = { on: true, projects: "some", chosen: ["website"], models: ["Codex · gpt-5.5"], ask: false };
  if (added && p("t3withheld")) binding.otto.t3.withheld = true;
  if (T.on && p("t3found")) binding.pip.t3found = true;
  // Which skills a bot sees: its own list when it has one; otherwise the gateway's
  // default list; with neither, every loaded skill (section 17).
  const SKILL = "clawtrate-t3";
  const DEFAULT_SKILLS = p("skilldef") === "1" ? ["github", "weather"] : null;
  const effectiveSkills = (id) => binding[id].skills || DEFAULT_SKILLS; // null: every loaded skill
  const seesSkill = (id) => {
    const list = effectiveSkills(id);
    return !list || list.includes(SKILL);
  };
  const PROJECTS = ["website", "home-scripts", "newsletter"];
  const T3MODELS = ["Codex · gpt-5.5", "Codex · gpt-5.5-mini", "Claude · claude-sonnet-5.5"];
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const usingBots = () => Object.keys(binding).filter((id) => binding[id].t3?.on);
  const sw = (on, attrs, label) => `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}" ${attrs}></button>`;
  const switchRow = (title, sub, on, attrs, label) =>
    `<div class="b-row"><span class="b-row-main"><span>${title}</span>${sub ? `<small>${sub}</small>` : ""}</span>${sw(on, attrs, label)}</div>`;
  const and = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
  const OBSERVED = {
    none: ["", "Not observed yet"],
    saved: ["ok", "Saved by Clawtrate's sign-in, Nov 17, 5:36 PM"],
    worked: ["ok", "Worked: Otto's T3 Code call returned, Nov 17, 5:41 PM"],
    refused: ["warn", "Refused: Otto's T3 Code call, Nov 17, 5:52 PM. T3 Code said: A valid T3 Code MCP credential is required."],
  };

  // Settings, Integrations ------------------------------------------------------------------------

  CT.botsSections.push(["integrations", "Integrations"]);
  CT.botsSectionViews = CT.botsSectionViews || {};
  CT.botsSectionViews.integrations = ({ back }) => {
    // The switch is this person's preference: changing it needs write, not admin.
    const canPref = B.access !== "read";
    const others = usingBots().map(botName);
    const line = !T.on && others.length
      ? `Off for you. ${esc(and(others))} ${others.length === 1 ? "has" : "have"} T3 Code on at the gateway; this doesn't change that.`
      : "Let bots start and follow threads in T3 Code, a coding app you run. Off by default; nothing else in Clawtrate needs it.";
    let body = `<dl class="facts">${switchRow("T3 Code", line, T.on, `data-t3="toggle"${canPref ? "" : " disabled"}`, "T3 Code integration")}</dl>`;
    if (T.on) body += serverPart() + (T.server ? signinPart() + botsPart() : "");
    const foot =
      B.access === "read"
        ? `<section class="access-bar" role="region" aria-label="Access"><div class="access-row">${icon("eye")}<span class="shelf-text"><b>Read-only.</b> This is your own preference; saving it needs this device to be able to send.</span>${button("Request access", 'data-b="request-write" data-size="sm"', "primary")}</div></section>`
        : !isAdmin() && T.on
          ? adminBar("Adding T3 Code to the gateway needs admin access.")
          : "";
    return { title: "Integrations", back, body, foot };
  };

  function serverPart() {
    if (T.write === "checking") return `<h4 class="b-group">Server</h4>` + D.wait("Checking whether T3 Code was added…");
    if (T.server)
      return (
        `<h4 class="b-group">Server</h4><dl class="facts"><div><dt>Address</dt><dd>${esc(T.server)}</dd></div>` +
        `<div><dt>Name on the gateway</dt><dd class="mono">t3code</dd></div></dl>`
      );
    return (
      `<h4 class="b-group">Server</h4>` +
      `<p class="b-step">Add your T3 Code server to the gateway. Copy its address from T3 Code's settings.</p>` +
      `<label class="b-field" style="margin-top:0"><span>T3 Code address</span><input class="input" data-t3-address placeholder="https://code.example.net" value="${esc(T.address)}"${isAdmin() ? "" : " disabled"}${T.error ? ' aria-invalid="true" aria-describedby="t3-error"' : ""} /></label>` +
      (T.error ? `<p class="b-field-error" id="t3-error">${T.error}</p>` : `<p class="b-hint">T3 Code signs in only over https, or on the gateway's own machine (localhost).</p>`) +
      `<p class="b-hint">Adding it turns T3 Code off for every bot first, so no bot gets its tools until you turn it on for that bot.</p>` +
      (T.write === "refused" ? note(`<p>Couldn't add T3 Code: the gateway refused the change. Nothing changed.</p>`, "danger") : "") +
      (isAdmin() ? `<div class="b-actions" style="margin-top:12px">${button(T.write === "refused" ? "Try again" : "Add to gateway", 'data-t3="add" data-size="sm"', "primary")}</div>` : "")
    );
  }

  function signinPart() {
    let html = `<h4 class="b-group">The gateway's sign-in</h4>`;
    const stage = T.stage;
    if (T.origin && isAdmin() && stage === "starting") return html + D.wait("Asking the gateway to start the sign-in…") + `<div class="b-actions">${button("Cancel", 'data-t3="cancel" data-size="sm"', "quiet")}</div>`;
    if (T.origin && isAdmin() && stage === "waiting")
      return (
        html +
        `<ol class="b-steps"><li><p>Open T3 Code's page and approve the gateway. If that browser isn't signed in to T3 Code, enter a pairing code from T3 Code's settings there.</p>${button(`Open T3 Code's page ${icon("external")}`, 'data-t3="open-link"')}</li></ol>` +
        D.wait("Waiting for T3 Code. This works for 10 minutes.") +
        `<div class="b-actions" style="margin-top:8px">${button("Cancel", 'data-t3="cancel" data-size="sm"', "quiet")}</div>`
      );
    if (["failed", "expired", "cancelled"].includes(stage)) {
      const r = {
        failed: ["danger", "warning", "Couldn't sign in", "T3 Code refused the gateway's sign-in."],
        expired: ["warn", "clock", "The sign-in expired", "It wasn't approved in time."],
        cancelled: ["", "x", "Sign-in cancelled", ""],
      }[stage];
      html += D.result(...r).replace(" data-b-focus", "") + `<div class="b-actions" style="justify-content:center">${button("Start again", 'data-t3="signin" data-size="sm"', "primary")}</div>`;
    }
    // What Clawtrate observed, and when; never "Signed in" as a live fact.
    const [tone, word] = OBSERVED[T.observed];
    const listing = {
      listed: "8 T3 Code tools for Otto's latest task",
      notconnected: "The gateway says: not connected",
      stale: "The gateway says: stale configuration",
    }[T.listing];
    html +=
      `<dl class="facts"><div><dt>Last observed</dt><dd class="b-wrap-value"><span class="b-state"${tone ? ` data-tone="${tone}"` : ""}>${tone ? icon(tone === "ok" ? "check" : "warning") : ""}${esc(word)}</span></dd></div>` +
      `<div><dt>Ends</dt><dd class="b-wrap-value">${T.observed === "saved" ? "By Dec 17 (T3 Code ends a sign-in after 30 days)" : "Unknown: Clawtrate didn't see this sign-in made."}</dd></div>` +
      `<div><dt>Gateway's last listing</dt><dd class="b-wrap-value">${listing}<small class="b-faint">a cached list, not a check of the sign-in</small></dd></div></dl>` +
      (T.observed === "none"
        ? `<p class="b-hint">Clawtrate learns whether the gateway is signed in when its own sign-in finishes, or when a bot with T3 Code on makes its first T3 Code call.</p>`
        : "") +
      `<p class="b-hint">Clawtrate can't see a sign-in that was revoked or ended in T3 Code until a call is refused.</p>`;
    if (T.origin && isAdmin()) {
      if (!["failed", "expired", "cancelled"].includes(stage))
        html +=
          (T.observed === "none" ? `<p class="b-step" style="margin-top:12px">The gateway signs in to T3 Code and keeps the sign-in. You approve it on T3 Code's page.</p>` : "") +
          `<div class="b-actions" style="margin-top:12px">${button(T.observed === "none" ? "Sign in" : "Sign in again", 'data-t3="signin" data-size="sm"', T.observed === "none" || T.observed === "refused" ? "primary" : "")}</div>`;
      return html;
    }
    // This connection can't start it: the gateway's own command-line sign-in, in full.
    const login = "openclaw mcp login t3code";
    const code = "openclaw mcp login t3code --code <code>";
    return (
      html +
      `<h4 class="b-group">${T.observed === "none" ? "Sign in" : "Sign in again"} on the gateway's machine</h4>` +
      `<ol class="b-steps">` +
      `<li><p>On the gateway's machine, run:</p><div class="command-line"><code>${cmd(login)}</code>${copy("sign-in command", login)}</div></li>` +
      `<li><p>It prints an address. Open it in a browser and approve the gateway on T3 Code's page, or enter a pairing code from T3 Code there.</p></li>` +
      `<li><p>If that browser is on the gateway's machine, T3 Code returns to the command by itself; it waits 5 minutes. When it prints "MCP OAuth credentials saved", the gateway is signed in.</p></li>` +
      `<li><p>If the browser is on another computer, the page it returns to won't open. Copy the code from that page's address (the part after <code>code=</code>) and run this on the gateway's machine:</p><div class="command-line"><code>${cmd(code)}</code>${copy("code command", code)}</div></li>` +
      `</ol><p class="b-hint" style="margin-top:0">Or sign in from Settings on the gateway's own web page.</p>`
    );
  }

  function botsPart() {
    const on = usingBots();
    const found = Object.keys(binding).filter((id) => binding[id].t3found);
    return (
      `<h4 class="b-group">Bots</h4>` +
      `<p class="b-step" style="margin-bottom:0">${on.length ? `T3 Code is on for ${esc(and(on.map(botName)))}.` : "T3 Code is off for every bot."} Turn it on for a bot in that bot's settings.</p>` +
      (T.stillOn ? note(`<p>T3 Code is still on for ${esc(botName(T.stillOn))}.</p>${isAdmin() ? `<div class="b-actions">${button(`Try again for ${esc(botName(T.stillOn))}`, `data-t3="retry-off" data-t3bot="${T.stillOn}" data-size="sm"`)}</div>` : ""}`, "warn") : "") +
      (T.write === "off-refused" ? note(`<p>Couldn't turn off T3 Code for ${esc(and(on.map(botName)))}: the gateway refused the change. Nothing changed.</p>`, "danger") : "") +
      found
        .map((id) =>
          note(
            `<p>${esc(botName(id))} has the T3 Code tools without being turned on, because it was made outside Clawtrate.</p>` +
              (isAdmin() ? `<div class="b-actions">${button(`Turn off for ${esc(botName(id))}`, `data-t3="deny" data-t3bot="${id}" data-size="sm"`)}</div>` : ""),
            "warn",
          ),
        )
        .join("")
    );
  }

  // A bot's own switch and limits --------------------------------------------------------------------

  CT.botsT3Row = (id) => {
    if (!T.on) return "";
    const t = binding[id].t3 || { on: false };
    const ready = Boolean(T.server);
    const sub = !ready
      ? "Add T3 Code in Settings first."
      : t.on && t.withheld
        ? "On, but the gateway doesn't offer Otto the T3 Code tools: not connected."
        : T.observed === "none"
          ? "Start and follow threads in T3 Code. Whether the gateway's sign-in works shows with the first call."
          : "Start and follow threads in T3 Code.";
    return (
      `<h4 class="b-group">T3 Code</h4><dl class="facts">${switchRow("T3 Code", sub, t.on, `data-t3="bot-toggle" data-t3bot="${id}"${ready && isAdmin() ? "" : " disabled"}`, `T3 Code for ${esc(botName(id))}`)}` +
      (t.on ? `<div><button type="button" class="b-open" data-bs="t3" aria-label="T3 Code limits for ${esc(botName(id))}. Open."><span>Limits</span><span class="b-open-value"><span>${limitsWord(t)}</span></span>${icon("chevron")}</button></div>` : "") +
      `</dl>` +
      (t.on && !T.plugin ? `<p class="b-hint">Without Clawtrate's plugin, ${esc(botName(id))} gets the T3 Code tools without Clawtrate's instructions for them.</p>` : "") +
      (t.on && T.plugin && t.skillUnconfirmed
        ? note(`<p>On. Clawtrate couldn't confirm the T3 Code skill for ${esc(botName(id))}.</p><div class="b-actions">${button("Try again", `data-t3="skill-retry" data-t3bot="${id}" data-size="sm"`)}</div>`, "warn")
        : "") +
      (t.on && T.plugin && binding[id].skillsWritten && !t.skillUnconfirmed
        ? `<p class="b-hint">${esc(botName(id))} has a list of skills of its own: the gateway's default list as it was, plus T3 Code. It no longer follows the default list.</p>`
        : "") +
      (t.writeError ? note(`<p>Couldn't change T3 Code for ${esc(botName(id))}: the gateway refused the change.</p>`, "danger") : "") +
      (!ready && isAdmin() ? `<div class="b-actions" style="margin-top:8px">${button("Open Settings", 'data-t3="open-settings" data-size="sm"')}</div>` : "")
    );
  };
  const limitsWord = (t) => (!T.plugin ? "None" : `${t.projects === "all" ? "All projects" : `${t.chosen.length} project${t.chosen.length === 1 ? "" : "s"}`}, ${t.ask ? "asks first" : "doesn't ask"}`);

  CT.botsT3View = (id) => {
    const t = binding[id].t3;
    const name = esc(botName(id));
    let html = `<div class="b-subhead"><button type="button" class="icon-button" data-variant="quiet" data-bs="main" aria-label="Back to settings">${icon("back")}</button><h3 tabindex="-1" data-bs-focus>T3 Code</h3></div>`;
    if (!T.plugin)
      return (
        html +
        note(`<p><b>Limits need Clawtrate's plugin on the gateway.</b> Without it, ${name} can use any project, provider and model its T3 Code sign-in allows, and starting a thread doesn't ask first.</p>`) +
        `<p class="b-hint">T3 Code itself limits an outside app only by the access level approved at sign-in.</p>`
      );
    const dis = isAdmin() ? "" : " disabled";
    html += `<p class="b-lead" style="text-align:left">What ${name} may do in T3 Code. A thread outside these is refused on the gateway, before it reaches T3 Code, and its card reads Not sent.</p>`;
    if (T.catalog === "loading")
      return html + `<div aria-busy="true" aria-label="Loading T3 Code's projects"><div class="skeleton" style="height:42px;width:100%"></div><div class="skeleton" style="height:42px;width:100%"></div><div class="skeleton" style="height:42px;width:100%"></div></div>`;
    if (T.catalog === "error")
      html += note(
        `<p>Couldn't load T3 Code's projects: the gateway is not signed in to T3 Code. The saved limits still apply: ${t.projects === "all" ? "all projects" : esc(t.chosen.join(", "))}.</p><div class="b-actions">${button("Try again", 'data-t3="catalog-retry" data-size="sm"')}</div>`,
        "danger",
      );
    if (T.catalog === "error") return html;
    html +=
      `<h4 class="b-group" id="t3-projects-label">Projects</h4><dl class="facts" role="radiogroup" aria-labelledby="t3-projects-label">` +
      [["all", "All projects"], ["some", "Only these"]].map(([v, l]) => `<div><button type="button" class="b-open" role="radio" aria-checked="${t.projects === v}" tabindex="${t.projects === v ? 0 : -1}" data-t3="projects" data-value="${v}"${dis}><span>${l}</span>${t.projects === v ? icon("check") : ""}</button></div>`).join("") +
      `</dl>` +
      (t.projects === "some"
        ? `<dl class="facts" style="margin-top:8px">${PROJECTS.map((pr) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-t3-project="${pr}"${t.chosen.includes(pr) ? " checked" : ""}${dis} /> ${pr}</label></div>`).join("")}</dl>` +
          (t.chosen.length ? "" : `<p class="b-field-error" role="alert" style="margin-top:6px">Choose at least one project, or allow all. Nothing is saved until then.</p>`)
        : "") +
      `<h4 class="b-group">Providers and models</h4><dl class="facts">${T3MODELS.map((m) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-t3-model="${m}"${t.models.includes(m) ? " checked" : ""}${dis} /> ${m}</label></div>`).join("")}</dl>` +
      (t.models.length ? `<p class="b-hint">As T3 Code lists them for the gateway's sign-in.</p>` : `<p class="b-field-error" role="alert">Choose at least one model. Nothing is saved until then.</p>`) +
      `<h4 class="b-group">Approval</h4><dl class="facts">${switchRow("Ask before starting a thread", "On: a card asks you first, in the conversation.", t.ask, `data-t3="ask"${dis}`, "Ask before starting a thread")}</dl>`;
    return html;
  };

  // Wiring ----------------------------------------------------------------------------------------------

  const rerender = () => D.rerender();
  let timer = null;
  function setStage(s) {
    clearTimeout(timer);
    T.stage = s;
    rerender();
    if (s === "starting") timer = setTimeout(() => setStage("waiting"), 700);
  }
  function turnOffForBots() {
    const on = usingBots();
    const how = p("t3write");
    if (how === "refused") {
      T.write = "off-refused";
      return rerender();
    }
    // One write for all of them, then the read-back, which may show one still on.
    on.forEach((id) => (binding[id].t3.on = false));
    if (how === "partial") {
      binding[on[on.length - 1]].t3.on = true;
      T.stillOn = on[on.length - 1];
      return rerender();
    }
    T.on = false;
    T.write = null;
    rerender();
    $('[data-t3="toggle"]')?.focus();
    announce(`T3 Code is off for you and for ${and(on.map(botName))}`);
  }

  document.addEventListener("click", (event) => {
    const t = event.target.closest("[data-t3]");
    if (event.target.closest('.copy[data-what="sign-in command"]')) {
      T.copied = true;
      setTimeout(rerender, 0);
    }
    if (!t || t.disabled) return;
    const what = t.dataset.t3;
    if (what === "toggle") {
      const on = usingBots().map(botName);
      if (T.on && on.length) {
        // What turning it off does depends on what this device may do.
        if (!isAdmin())
          return D.confirmBox({
            title: "Turn off T3 Code for you?",
            text: `${and(on)} ${on.length === 1 ? "has" : "have"} T3 Code on at the gateway, and ${on.length === 1 ? "keeps" : "keep"} it: turning it off for ${on.length === 1 ? "it" : "them"} needs admin access. This only hides T3 Code in Clawtrate for you.`,
            action: "",
            label: "Hide T3 Code",
            run: () => {
              T.on = false;
              rerender();
              $('[data-t3="toggle"]')?.focus();
              announce("T3 Code is hidden for you");
            },
          });
        return D.confirmBox({
          title: "Turn off T3 Code?",
          text: `${and(on)} ${on.length === 1 ? "has" : "have"} T3 Code on. Bots are shared: turning it off for ${and(on)} turns it off for everyone who uses ${on.length === 1 ? "it" : "them"}, and ${on.length === 1 ? "it loses" : "they lose"} the T3 Code tools and Clawtrate's skill. The T3 Code server and its sign-in stay on the gateway for next time.`,
          action: "danger",
          label: `Turn off for ${and(on)} too`,
          alt: ["Only hide it", () => {
            T.on = false;
            rerender();
            $('[data-t3="toggle"]')?.focus();
            announce("T3 Code is hidden for you");
          }],
          run: turnOffForBots,
        });
      }
      T.on = !T.on;
      rerender();
      $('[data-t3="toggle"]')?.focus();
      announce(T.on ? "T3 Code is on" : "T3 Code is off");
    }
    if (what === "add") {
      const value = $("[data-t3-address]").value.trim();
      const ok = /^https:\/\/[^\s/]+/.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(value);
      T.address = value;
      if (!ok) {
        T.error = value ? "T3 Code signs in only over https, or on localhost. Use its https address." : "Enter T3 Code's address.";
        rerender();
        return $("[data-t3-address]").focus();
      }
      T.error = "";
      const how = p("t3write");
      if (how === "refused" && T.write !== "refused") {
        T.write = "refused";
        rerender();
        return $('[data-t3="add"]')?.focus();
      }
      // Denies first and the server, in one write; an unanswered write is read back before anything is sent again.
      T.write = how === "timeout" ? "checking" : null;
      if (T.write === "checking") {
        rerender();
        return setTimeout(() => {
          T.write = null;
          T.server = value.replace(/\/mcp\/?$/, "");
          T.observed = "none";
          rerender();
          announce("T3 Code added to the gateway");
        }, 900);
      }
      T.server = value.replace(/\/mcp\/?$/, "");
      T.observed = "none";
      rerender();
      announce("T3 Code added to the gateway");
    }
    if (what === "signin") setStage("starting");
    if (what === "cancel") setStage("cancelled");
    if (what === "open-link") announce("Opened in your browser");
    if (what === "deny") {
      delete binding[t.dataset.t3bot].t3found;
      rerender();
      announce(`T3 Code turned off for ${botName(t.dataset.t3bot)}`);
    }
    if (what === "retry-off") {
      binding[t.dataset.t3bot].t3.on = false;
      T.stillOn = null;
      T.on = false;
      rerender();
      announce(`T3 Code is off for ${botName(t.dataset.t3bot)}`);
    }
    if (what === "bot-toggle") {
      const id = t.dataset.t3bot;
      const cur = binding[id].t3 || { on: false, projects: "all", chosen: [], models: [...T3MODELS], ask: false };
      if (p("t3write") === "refused") {
        cur.writeError = true;
        binding[id].t3 = cur;
        CT.botsRender();
        return $('[data-t3="bot-toggle"]')?.focus();
      }
      const b = binding[id];
      const finish = () => {
        cur.writeError = false;
        binding[id].t3 = cur;
        CT.botsRender();
        $('[data-t3="bot-toggle"]')?.focus();
        announce(`T3 Code ${cur.on ? "on" : "off"} for ${botName(id)}${cur.skillUnconfirmed ? ", skill not confirmed" : ""}`);
      };
      if (!cur.on) {
        // Turning on: the deny goes, and the skill is given by the one list the bot follows.
        const enable = () => {
          cur.on = true;
          if (T.plugin && !seesSkill(id)) {
            if (b.skills) b.skills = [...b.skills, SKILL]; // its own list: add the name
            else {
              b.skills = [...DEFAULT_SKILLS, SKILL]; // follows the default: a list of its own
              b.skillsWritten = [...b.skills];
            }
          }
          // The read-back decides whether the skill is said to be in place.
          cur.skillUnconfirmed = T.plugin && (p("skillread") === "fail" || !seesSkill(id));
          if (p("skillchanged") === "1" && b.skillsWritten) b.skills = [...b.skills, "docs-search"];
          finish();
        };
        if (T.plugin && !b.skills && DEFAULT_SKILLS && !DEFAULT_SKILLS.includes(SKILL))
          return D.confirmBox({
            title: `Turn on T3 Code for ${botName(id)}?`,
            text: `${botName(id)} follows the gateway's default list of skills. To give ${botName(id)} the T3 Code skill, Clawtrate gives ${botName(id)} a list of its own: today's default list plus T3 Code. From then on, ${botName(id)} stops following the gateway's default list: a skill added to the default later won't reach ${botName(id)}.`,
            action: "",
            label: "Turn on",
            run: enable,
          });
        return enable();
      }
      // Turning off: the deny comes back and the skill goes; a list Clawtrate wrote
      // and nobody changed since is removed, so the bot follows the default again.
      cur.on = false;
      cur.skillUnconfirmed = false;
      if (b.skills && b.skills.includes(SKILL)) {
        const rest = b.skills.filter((x) => x !== SKILL);
        const untouched = b.skillsWritten && rest.length === b.skillsWritten.length - 1 && rest.every((x) => b.skillsWritten.includes(x));
        if (untouched) delete b.skills;
        else b.skills = rest;
        delete b.skillsWritten;
      }
      finish();
    }
    if (what === "skill-retry") {
      const cur = binding[t.dataset.t3bot].t3;
      cur.skillUnconfirmed = !seesSkill(t.dataset.t3bot);
      CT.botsRender();
    }
    if (what === "projects") {
      binding[app.model.selectedBot].t3.projects = t.dataset.value;
      CT.botsRender();
    }
    if (what === "ask") {
      const b = binding[app.model.selectedBot].t3;
      b.ask = !b.ask;
      CT.botsRender();
    }
    if (what === "catalog-retry") {
      T.catalog = "ready";
      CT.botsRender();
    }
    if (what === "open-settings") D.openSettings(t, "integrations");
  });
  document.addEventListener("change", (event) => {
    const box = event.target.closest("[data-t3-project], [data-t3-model]");
    if (!box) return;
    const b = binding[app.model.selectedBot].t3;
    const list = box.dataset.t3Project ? b.chosen : b.models;
    const value = box.dataset.t3Project || box.dataset.t3Model;
    if (box.checked && !list.includes(value)) list.push(value);
    if (!box.checked) list.splice(list.indexOf(value), 1);
    CT.botsRender();
    $(`[data-t3-project="${box.dataset.t3Project}"], [data-t3-model="${box.dataset.t3Model}"]`)?.focus();
  });
  document.addEventListener("input", (event) => {
    if (event.target.matches("[data-t3-address]")) T.address = event.target.value;
  });

  // Prototype controls: what T3 Code and the gateway would report.
  const extra = $("#proto-extra .run-controls");
  if (extra) {
    extra.insertAdjacentHTML("afterbegin", `<button type="button" data-t3-proto="approve">T3 approved</button><button type="button" data-t3-proto="refused">T3 call refused</button>`);
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-t3-proto]")?.dataset.t3Proto;
      if (!what) return;
      if (what === "approve") {
        T.observed = T.origin ? "saved" : "worked";
        T.stage = null;
      }
      if (what === "refused") T.observed = "refused";
      rerender();
    });
  }

  window.t3 = {
    T,
    setStage,
    observe: (o) => {
      T.observed = o;
      T.stage = null;
      rerender();
    },
  };
  if (p("t3signin") === "starting") setStage("starting");
  if (p("open") === "settings") D.renderSettings();
  CT.botsRender();
})();
