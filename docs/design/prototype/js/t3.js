// T3 Code, optional (docs/design/bots.md, sections 15 to 18): the switch in
// Settings, Integrations; adding a T3 Code server to the gateway and signing the
// gateway in to it; each bot's own switch and limits; turning it off.
// With the switch off, nothing about T3 Code appears anywhere else.
//
// More address parameters:
//   t3=on                    the integration is on (off by default)
//   t3server=none            no T3 Code server on the gateway yet (default: added)
//   t3signin=none|starting|waiting|failed|expired|cancelled|unseen|expiring   the gateway's sign-in
//   t3origin=1               this connection can start the gateway's sign-in itself
//   t3plugin=0               Clawtrate's gateway plugin is absent, so no limits
//   t3found=1                a bot has the T3 Code tools without being switched on
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

  const T = {
    on: p("t3") === "on",
    server: p("t3") === "on" && p("t3server") !== "none" ? "https://code.example.net" : null,
    address: "",
    error: "",
    signin: p("t3") === "on" && p("t3server") !== "none" ? p("t3signin") || "signed" : "none",
    origin: p("t3origin") === "1",
    plugin: p("t3plugin") !== "0",
    copied: false,
    confirmedFrom: "Otto's tools",
  };
  if (T.on && T.server) binding.otto.t3 = { on: true, projects: "some", chosen: ["website"], models: ["Codex · gpt-5.5"], ask: true };
  if (T.on && p("t3found")) binding.pip.t3found = true;
  const PROJECTS = ["website", "home-scripts", "newsletter"];
  const T3MODELS = ["Codex · gpt-5.5", "Codex · gpt-5.5-mini", "Claude · claude-sonnet-5.5"];
  const botName = (id) => app.bots.find((b) => b.id === id)?.name || id;
  const usingBots = () => Object.keys(binding).filter((id) => binding[id].t3?.on);
  const sw = (on, attrs, label) => `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="${label}" ${attrs}></button>`;
  const switchRow = (title, sub, on, attrs, label) =>
    `<div class="b-row"><span class="b-row-main"><span>${title}</span>${sub ? `<small>${sub}</small>` : ""}</span>${sw(on, attrs, label)}</div>`;
  const signedIn = () => ["signed", "expiring"].includes(T.signin);

  // Settings, Integrations ------------------------------------------------------------------------

  D.B && CT.botsSections.push(["integrations", "Integrations"]);
  CT.botsSectionViews = CT.botsSectionViews || {};
  CT.botsSectionViews.integrations = ({ back }) => {
    const canPref = B.access !== "read"; // the switch is the person's own preference; changing it needs write
    let body =
      `<dl class="facts">${switchRow("T3 Code", "Let bots start and follow threads in T3 Code, a coding app you run. Off by default; nothing else in Clawtrate needs it.", T.on, `data-t3="toggle"${canPref ? "" : " disabled"}`, "T3 Code integration")}</dl>`;
    if (T.on) body += serverPart() + (T.server ? signinPart() + botsPart() : "");
    const foot = !isAdmin() && T.on ? adminBar("Adding T3 Code to the gateway needs admin access.") : B.access === "read" ? adminBar("Changing integrations needs more access.") : "";
    return { title: "Integrations", back, body, foot };
  };

  function serverPart() {
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
      (isAdmin() ? `<div class="b-actions" style="margin-top:12px">${button("Add to gateway", 'data-t3="add" data-size="sm"', "primary")}</div>` : "")
    );
  }

  function signinPart() {
    let html = `<h4 class="b-group">The gateway's sign-in</h4>`;
    const s = T.signin;
    if (signedIn() || s === "unseen") {
      const tone = s === "expiring" ? "warn" : s === "unseen" ? "warn" : "ok";
      const word = s === "unseen" ? "Not seen" : "Signed in";
      html +=
        `<dl class="facts"><div><dt>State</dt><dd><span class="b-state" data-tone="${tone}">${icon(tone === "ok" ? "check" : "warning")}${word}</span></dd></div>` +
        `<div><dt>Confirmed</dt><dd>Nov 17, ${s === "signed" || s === "expiring" ? `from ${T.confirmedFrom}` : "from Otto's tools"}</dd></div>` +
        `<div><dt>Expires</dt><dd${s === "expiring" ? ' class="b-warn"' : ""}>${s === "expiring" ? "By Nov 19 at the latest" : "By Dec 17 at the latest"}</dd></div>` +
        `<div><dt>Gateway's last report</dt><dd>${s === "unseen" ? "No T3 Code tools for Otto, 5:36 PM" : "8 T3 Code tools for Otto, 5:36 PM"}</dd></div></dl>` +
        (s === "expiring"
          ? note(`<p>T3 Code ends a sign-in after 30 days, and this one began by Oct 20. Sign in again before Nov 19.</p>`, "warn")
          : s === "unseen"
            ? note(`<p>The gateway lists no T3 Code tools for Otto any more. The sign-in may have ended in T3 Code, or the server can't be reached.</p>`, "warn")
            : `<p class="b-hint">T3 Code ends a sign-in after 30 days, with no renewal. Clawtrate counts from when it saw the sign-in work, so the real date can be earlier.</p>`) +
        (isAdmin() || !T.origin ? `<div class="b-actions" style="margin-top:12px">${button("Sign in again", 'data-t3="signin-again" data-size="sm"', s === "signed" ? "" : "primary")}</div>` : "");
      return html;
    }
    if (["failed", "expired", "cancelled"].includes(s)) {
      const r = {
        failed: ["danger", "warning", "Couldn't sign in", "T3 Code refused the gateway's sign-in. Nothing was saved."],
        expired: ["warn", "clock", "The sign-in expired", "It wasn't approved in time. Nothing was saved."],
        cancelled: ["", "x", "Sign-in cancelled", "Nothing was saved."],
      }[s];
      return html + D.result(...r).replace(" data-b-focus", "") + `<div class="b-actions" style="justify-content:center">${button("Start again", 'data-t3="signin" data-size="sm"', "primary")}</div>`;
    }
    if (T.origin && isAdmin()) {
      if (s === "starting") return html + D.wait("Asking the gateway to start the sign-in…") + `<div class="b-actions">${button("Cancel", 'data-t3="cancel" data-size="sm"', "quiet")}</div>`;
      if (s === "waiting")
        return (
          html +
          `<ol class="b-steps"><li><p>Open T3 Code's page and approve the gateway. If that browser isn't signed in to T3 Code, enter a pairing code from T3 Code's settings there.</p>${button(`Open T3 Code's page ${icon("external")}`, 'data-t3="open-link"')}</li></ol>` +
          D.wait("Waiting for T3 Code. This works for 10 minutes.") +
          `<div class="b-actions" style="margin-top:8px">${button("Cancel", 'data-t3="cancel" data-size="sm"', "quiet")}</div>`
        );
      return html + `<p class="b-step">The gateway signs in to T3 Code and keeps the sign-in. You approve it on T3 Code's page.</p><div class="b-actions">${button("Sign in", 'data-t3="signin" data-size="sm"', "primary")}</div>`;
    }
    // This connection can't start it: the gateway's own command, run on its machine.
    const line = "openclaw mcp login t3code";
    return (
      html +
      `<p class="b-step">This connection can't start the gateway's sign-in. Run this on the gateway's machine, then approve the gateway on T3 Code's page:</p>` +
      `<div class="command-line"><code>${cmd(line)}</code>${copy("sign-in command", line)}</div>` +
      `<p class="b-hint" style="margin-top:0">Or sign in from Settings on the gateway's own web page.</p>` +
      (T.copied
        ? `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>Checking Otto's tools for T3 Code, again in 4s</p>`
        : `<p class="b-hint">Clawtrate confirms the sign-in by itself, from the T3 Code tools of a bot that has T3 Code on${usingBots().length ? "" : ". No bot has it on yet"}.</p>`)
    );
  }

  function botsPart() {
    const on = usingBots();
    const found = Object.keys(binding).filter((id) => binding[id].t3found);
    return (
      `<h4 class="b-group">Bots</h4>` +
      `<p class="b-step" style="margin-bottom:0">${on.length ? `T3 Code is on for ${esc(on.map(botName).join(", "))}.` : "T3 Code is off for every bot."} Turn it on for a bot in that bot's settings.</p>` +
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
    const ready = T.server && (signedIn() || T.signin === "unseen");
    const sub = !T.server ? "Add T3 Code in Settings first." : !ready ? "Sign the gateway in to T3 Code first, in Settings." : "Start and follow threads in T3 Code.";
    return (
      `<h4 class="b-group">T3 Code</h4><dl class="facts">${switchRow("T3 Code", sub, t.on, `data-t3="bot-toggle" data-t3bot="${id}"${ready && isAdmin() ? "" : " disabled"}`, `T3 Code for ${esc(botName(id))}`)}` +
      (t.on ? `<div><button type="button" class="b-open" data-bs="t3" aria-label="T3 Code limits for ${esc(botName(id))}. Open."><span>Limits</span><span class="b-open-value"><span>${limitsWord(t)}</span></span>${icon("chevron")}</button></div>` : "") +
      `</dl>` +
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
    html +=
      `<p class="b-lead" style="text-align:left">What ${name} may do in T3 Code. A thread outside these is refused on the gateway, before it reaches T3 Code, and its card reads Not sent.</p>` +
      `<h4 class="b-group" id="t3-projects-label">Projects</h4><dl class="facts" role="radiogroup" aria-labelledby="t3-projects-label">` +
      [["all", "All projects"], ["some", "Only these"]].map(([v, l]) => `<div><button type="button" class="b-open" role="radio" aria-checked="${t.projects === v}" data-t3="projects" data-value="${v}"${dis}><span>${l}</span>${t.projects === v ? icon("check") : ""}</button></div>`).join("") +
      `</dl>` +
      (t.projects === "some"
        ? `<dl class="facts" style="margin-top:8px">${PROJECTS.map((pr) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-t3-project="${pr}"${t.chosen.includes(pr) ? " checked" : ""}${dis} /> ${pr}</label></div>`).join("")}</dl>` +
          (t.chosen.length ? "" : `<p class="b-field-error" style="margin-top:6px">Choose at least one project, or allow all.</p>`)
        : "") +
      `<h4 class="b-group">Providers and models</h4><dl class="facts">${T3MODELS.map((m) => `<div class="b-row"><label class="b-check"><input type="checkbox" data-t3-model="${m}"${t.models.includes(m) ? " checked" : ""}${dis} /> ${m}</label></div>`).join("")}</dl>` +
      `<p class="b-hint">As T3 Code lists them for the gateway's sign-in.</p>` +
      `<h4 class="b-group">Approval</h4><dl class="facts">${switchRow("Ask before starting a thread", "On: a card asks you first, in the conversation.", t.ask, `data-t3="ask"${dis}`, "Ask before starting a thread")}</dl>`;
    return html;
  };

  // Wiring ----------------------------------------------------------------------------------------------

  const rerender = () => D.rerender();
  let timer = null;
  function setSignin(s) {
    clearTimeout(timer);
    T.signin = s;
    rerender();
    if (s === "starting") timer = setTimeout(() => setSignin("waiting"), 700);
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
      if (T.on && usingBots().length) {
        const on = usingBots().map(botName);
        return D.confirmBox({
          title: "Turn off T3 Code?",
          text: `${on.join(" and ")} ${on.length === 1 ? "has" : "have"} T3 Code on. Turning the integration off turns it off for ${on.length === 1 ? "it" : "them"}: ${on.length === 1 ? "it loses" : "they lose"} the T3 Code tools and skill. The T3 Code server and its sign-in stay on the gateway for next time.`,
          action: "danger",
          label: "Turn off",
          run: () => {
            usingBots().forEach((id) => (binding[id].t3.on = false));
            T.on = false;
            rerender();
            $('[data-t3="toggle"]')?.focus();
            announce("T3 Code is off");
          },
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
      T.server = value.replace(/\/mcp\/?$/, "");
      T.signin = "none";
      rerender();
      announce("T3 Code added to the gateway");
    }
    if (what === "signin" || what === "signin-again") {
      if (!T.origin) {
        T.signin = "none";
        T.copied = false;
        return rerender();
      }
      setSignin("starting");
    }
    if (what === "cancel") setSignin("cancelled");
    if (what === "open-link") announce("Opened in your browser");
    if (what === "deny") {
      delete binding[t.dataset.t3bot].t3found;
      rerender();
      announce(`T3 Code turned off for ${botName(t.dataset.t3bot)}`);
    }
    if (what === "bot-toggle") {
      const id = t.dataset.t3bot;
      const cur = binding[id].t3 || { on: false, projects: "all", chosen: [], models: [...T3MODELS], ask: true };
      cur.on = !cur.on;
      binding[id].t3 = cur;
      CT.botsRender();
      $('[data-t3="bot-toggle"]')?.focus();
      announce(`T3 Code ${cur.on ? "on" : "off"} for ${botName(id)}`);
    }
    if (what === "projects") {
      binding[app.model.selectedBot].t3.projects = t.dataset.value;
      CT.botsRender();
      $(`[data-t3="projects"][data-value="${t.dataset.value}"]`)?.focus();
    }
    if (what === "ask") {
      const b = binding[app.model.selectedBot].t3;
      b.ask = !b.ask;
      CT.botsRender();
      $('[data-t3="ask"]')?.focus();
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
    extra.insertAdjacentHTML("afterbegin", `<button type="button" data-t3-proto="approve">T3 approved</button>`);
    extra.addEventListener("click", (event) => {
      if (!event.target.closest("[data-t3-proto]")) return;
      T.confirmedFrom = T.origin ? "Clawtrate's sign-in" : "Otto's tools";
      setSignin("signed");
      announce("Signed in to T3 Code");
    });
  }

  window.t3 = { T, setSignin };
  if (p("t3signin") === "starting") setSignin("starting");
  if (p("open") === "settings") D.renderSettings();
  CT.botsRender();
})();
