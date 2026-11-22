// Behaviour for setup-effortless.html: the screens of docs/design/setup-effortless.md,
// chosen with ?screen=<id>. No program runs and nothing is contacted. Codes,
// addresses, fingerprints and request ids are invented.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const icon = (name) => CT.icon(name);

  const go = (to, extra = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("screen", to);
    for (const key of ["warn", "tab", "typed", "result"]) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `setup-effortless.html?${next}`;
  };

  // 16 base32 characters of the SHA-256 of the device's public key, in four groups.
  const DEVICE = "K7QF-2MXA-9TRB-W4HD";
  const REQUEST = "7c41d2e0-9a3b-4f0e-8c55-2d6e1b0a9f34";
  const PRINT =
    "AB:12:9F:3C:77:E0:41:D8:5A:B2:0C:93:6E:F1:28:4D:C7:15:A9:3E:60:BB:D4:72:08:E5:1F:96:CA:3B:57:9F";
  const SCOPES = [
    ["Read gateway status, bots, visible sessions and history, and diagnostic data", "operator.read", ""],
    ["Send and stop work, invoke allowed tools and relay node commands", "operator.write", ""],
    ["Read and decide permitted exec and plugin approvals", "operator.approvals", ""],
    ["Read and answer interactive questions", "operator.questions", ""],
    ["Change gateway configuration, plugins or accounts, and open the gateway terminal where allowed", "operator.admin", "warn"],
    ["Receive pairing events and manage devices within the gateway's rules", "operator.pairing", "warn"],
  ];
  const CONSENT =
    "Full control lets Clawtrate change gateway settings, approve devices and, when the gateway allows it, open a terminal on the computer running OpenClaw.";

  const logo = "../../../packages/ui/src/assets/logo-mark.png";
  const brand = () =>
    `<header class="connect-brand"><img src="${logo}" alt="" width="56" height="56" />` +
    `<h1>Clawtrate</h1><p>Your OpenClaw agents, orchestrated.</p></header>`;
  const mark = () => `<img class="s-mark" src="${logo}" alt="" width="44" height="44" />`;
  const back = (to) =>
    `<div class="s-top"><a class="button" data-variant="quiet" data-size="sm" href="${go(to)}" data-back>${icon("back")}Back</a></div>`;
  const title = (text) => `<h2 class="s-title" tabindex="-1">${text}</h2>`;
  const lede = (html) => `<p class="s-lede">${html}</p>`;
  const hint = (html) => `<p class="s-hint">${html}</p>`;
  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(
        ([text, state]) =>
          `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""}>` +
          `<span class="s-step-mark">${state === "done" ? icon("check") : ""}</span><span>${text}</span><span class="s-step-time"></span></li>`,
      )
      .join("") +
    `</ol>`;
  const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const note = (tone, lead, text) =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="status">${icon(tone ? "warning" : "clock")}` +
    `<div><p>${lead ? `<b>${lead}</b> ` : ""}${text}</p></div></div>`;
  const scopeList = (rows = SCOPES) =>
    `<ul class="se-scopes">` +
    rows
      .map(([words, name, tone]) => `<li${tone ? ` data-tone="${tone}"` : ""}><span>${words}</span><code>${name}</code></li>`)
      .join("") +
    `</ul>`;
  const consent = () =>
    `<p class="se-full-line">${CONSENT} <a href="#what-this-means">What this means</a></p>`;
  const otherRow = () =>
    `<ul class="b-choices" aria-label="Or">` +
    `<li><a class="b-choice" href="${go("another")}"><span class="b-choice-text"><span class="b-choice-title">Another computer</span>` +
    `<span class="b-choice-sub">SSH, a secure address and token, or a setup code.</span></span>${icon("chevron")}</a></li>` +
    `</ul>`;

  // Screens --------------------------------------------------------------------

  const SCREENS = {
    // The settings were read; one socket is being proved before anything is offered.
    settings: () =>
      brand() +
      `<div class="se-found">` +
      `<p class="se-found-head"><span class="se-dot" data-state="pending" aria-hidden="true"></span>OpenClaw settings found</p>` +
      `<p class="se-found-sub">Port 18789 · default profile · version 2026.10.6</p>` +
      `<p class="se-checking" role="status">${icon("clock")} Checking what is listening at port 18789…</p>` +
      `</div>` +
      otherRow(),

    found: () =>
      brand() +
      `<div class="se-found">` +
      `<p class="se-found-head"><span class="se-dot" aria-hidden="true"></span>OpenClaw is running on this Mac</p>` +
      `<p class="se-found-sub">Port 18789 · default profile · version 2026.10.6</p>` +
      consent() +
      `<a class="button se-wide" data-variant="primary" data-size="lg" href="${go("connecting")}">Connect</a>` +
      `</div>` +
      otherRow(),

    unverified: () =>
      brand() +
      `<div class="se-found">` +
      `<p class="se-found-head"><span class="se-dot" data-state="warn" aria-hidden="true"></span>OpenClaw settings found</p>` +
      `<p class="se-found-sub">Port 18789 · default profile · version 2026.10.6</p>` +
      note("warn", "", "Clawtrate couldn't verify what is listening at port 18789. Nothing was sent to it.") +
      `<a class="button se-wide" data-size="lg" href="${go("settings")}">Look again</a>` +
      `</div>` +
      otherRow(),

    connecting: () =>
      mark() +
      title("Connecting to OpenClaw on this Mac") +
      steps([
        ["Reading OpenClaw's settings", "done"],
        ["Checking it's OpenClaw on this Mac", "done"],
        ["Pairing this Mac", "running"],
        ["Loading your bots", "waiting"],
      ]) +
      hint("No Terminal command and no approval: OpenClaw pairs a Mac with itself."),

    another: () => {
      const tab = params.get("tab") || "address";
      const warn = params.get("warn");
      const tabs = [
        ["ssh", "SSH"],
        ["address", "Address and token"],
        ["code", "Setup code"],
      ];
      const address = warn === "ws" ? "ws://192.0.2.10:18789" : "wss://gateway.example";
      const panel =
        tab === "ssh"
          ? `<label class="field"><span class="s-field-label">SSH host or alias</span>` +
            `<input class="input" type="text" placeholder="devbox or you@devbox.example" autocomplete="off" spellcheck="false" /></label>` +
            hint("Clawtrate reads OpenClaw's settings there and connects through SSH.")
          : tab === "code"
            ? `<label class="field"><span class="s-field-label">Setup code</span>` +
              `<textarea class="input se-code" rows="3" placeholder="Paste a setup code" spellcheck="false"></textarea></label>` +
              hint("Made by Clawtrate on another device, or by OpenClaw.")
            : `<label class="field"><span class="s-field-label">Gateway address</span>` +
              `<input class="input" type="text" value="${address}" placeholder="wss://gateway.example" spellcheck="false" /></label>` +
              (warn === "ws"
                ? note("danger", "", "This address would send the gateway token and chat traffic without encryption. Use a secure address (wss://) or SSH.")
                : "") +
              (warn === "cert"
                ? note("warn", "", "Clawtrate can't verify this gateway's certificate. Compare its SHA-256 fingerprint with the gateway owner over a channel you trust.") +
                  `<p class="se-print"><code>${PRINT}</code></p>`
                : "") +
              `<label class="field"><span class="s-field-label">Token</span>` +
              `<input class="input" type="password" value="sample-token-not-real" spellcheck="false" /></label>`;
      const action =
        tab === "ssh"
          ? `<a class="button se-wide" data-variant="primary" data-size="lg" href="${go("another", { tab: "ssh" })}">Continue</a>`
          : warn === "ws"
            ? `<button type="button" class="button se-wide" data-variant="primary" data-size="lg" disabled aria-disabled="true">Connect</button>`
            : warn === "cert"
              ? `<a class="button se-wide" data-variant="primary" data-size="lg" href="${go("waiting")}">Verify certificate</a>`
              : `<a class="button se-wide" data-variant="primary" data-size="lg" href="${go("waiting")}">Connect</a>`;
      return (
        back("found") +
        mark() +
        title("Another computer") +
        `<div class="se-tabs" role="tablist">` +
        tabs
          .map(([id, label]) => `<a role="tab" class="se-tab" aria-selected="${id === tab}" href="${go("another", { tab: id })}">${label}</a>`)
          .join("") +
        `</div>` +
        panel +
        (tab === "ssh" ? "" : consent()) +
        `<div class="s-actions">${action}</div>`
      );
    },

    waiting: () =>
      back("another") +
      mark() +
      title("Approve this Mac") +
      lede("Waiting for approval from the gateway's owner at <b>gateway.example</b>.") +
      `<p class="s-device se-device" aria-label="This device's code: ${DEVICE.split("").join(" ")}">${DEVICE}</p>` +
      `<p class="se-center se-muted">The approver types this code.</p>` +
      `<details class="b-disclosure se-asked"><summary>Asked for: full control</summary><div class="b-disclosure-body">${scopeList()}</div></details>` +
      `<ol class="se-ways">` +
      `<li><b>In Clawtrate</b> on a device already connected with full control.</li>` +
      `<li><b>In OpenClaw's Control UI</b> on the gateway's computer, under Devices.</li>` +
      `<li>Or on the gateway's computer, run:<div class="command"><code>openclaw devices approve ${REQUEST}</code>` +
      `<button type="button" class="icon-button copy" aria-label="Copy approve command">${icon("copy")}</button></div></li>` +
      `</ol>` +
      `<p class="se-waiting" role="status">${icon("clock")} Checking every few seconds · <a href="${go("waiting")}">Check now</a></p>`,
  };

  // The approve prompt, drawn over a stand-in for the app. The code is compared in
  // place as it is typed; Enter finishes editing and never decides.
  const CROCKFORD = (raw) =>
    raw.toUpperCase().replace(/[IL]/g, "1").replace(/O/g, "0").replace(/[^0-9A-HJKMNP-TV-Z]/g, "").slice(0, 16);
  const groups = (code) => code.match(/.{1,4}/g)?.join("-") ?? "";
  const prompt = () => {
    const result = params.get("result");
    if (result) {
      const text = {
        approved: "Approved. The device connects in a moment.",
        denied: "Denied. The device can ask again.",
        gone: "This request is no longer pending.",
      }[result];
      return `<div class="se-toast" role="status">${icon(result === "approved" ? "check" : "warning")}<span>${text}</span></div>`;
    }
    const typed = groups(CROCKFORD(params.get("typed") || ""));
    return (
      `<div class="se-scrim"><section class="se-prompt" role="dialog" aria-modal="true" aria-labelledby="se-prompt-title">` +
      `<div class="se-prompt-body">` +
      `<h2 id="se-prompt-title" tabindex="-1">Let a new device control this gateway?</h2>` +
      `<p class="se-gateway">Gateway <b>gateway.example</b></p>` +
      `<div class="se-who">` +
      facts([
        ["Name", `"My iPhone" <span class="se-muted">(reported)</span>`],
        ["Platform", `iOS <span class="se-muted">(reported)</span>`],
        ["App", `Clawtrate <span class="se-muted">(reported)</span>`],
        ["Seen by the gateway", "From 192.0.2.24"],
        ["Role", "operator"],
      ]) +
      `</div>` +
      `<h3 class="se-h3">It gets</h3>` +
      scopeList() +
      `</div>` +
      `<div class="se-prompt-foot">` +
      `<label class="field se-code-entry"><span class="s-field-label">Enter the code shown on the device you want to approve.</span>` +
      `<input class="input se-code-input" type="text" value="${typed}" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="19" aria-describedby="se-code-state" /></label>` +
      `<p class="se-code-state" id="se-code-state" role="status" aria-live="polite"></p>` +
      `<div class="se-prompt-buttons">` +
      `<a class="button" data-size="lg" href="${go("approve", { result: "denied" })}">Deny</a>` +
      `<button type="button" class="button" data-variant="primary" data-size="lg" id="se-approve" disabled aria-disabled="true">Approve</button>` +
      `</div></div>` +
      `</section></div>`
    );
  };

  const screen = params.get("screen") || "found";
  const card = document.getElementById("setup-card");
  if (screen === "approve") {
    card.innerHTML = SCREENS.found();
    document.getElementById("setup-over").innerHTML = prompt();
    const input = document.querySelector(".se-code-input");
    const state = document.getElementById("se-code-state");
    const approve = document.getElementById("se-approve");
    const update = () => {
      if (!input || !state || !approve) return;
      const code = CROCKFORD(input.value);
      const formatted = groups(code);
      if (input.value !== formatted) input.value = formatted;
      const match = formatted === DEVICE;
      approve.disabled = !match;
      approve.setAttribute("aria-disabled", String(!match));
      state.dataset.state = match ? "match" : code.length === 16 ? "wrong" : "";
      state.textContent = match ? "The code matches this request." : code.length === 16 ? "That code doesn't match this request." : "";
    };
    input?.addEventListener("input", update);
    // Enter finishes editing: on a match it moves focus to Approve; it never decides.
    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      if (approve && !approve.disabled) approve.focus();
    });
    approve?.addEventListener("click", () => {
      if (!approve.disabled) location.href = go("approve", { result: "approved" });
    });
    update();
    document.getElementById("se-prompt-title")?.focus();
  } else {
    card.innerHTML = (SCREENS[screen] || SCREENS.found)();
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && screen === "approve") location.href = go("found");
  });

  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    const all = [...Object.keys(SCREENS), "approve"];
    extra.innerHTML =
      `<label class="proto-seg">State <select id="se-state" aria-label="Setup state">` +
      all.map((key) => `<option value="${key}"${key === screen ? " selected" : ""}>${key}</option>`).join("") +
      `</select></label>`;
    document.getElementById("se-state").addEventListener("change", (event) => (location.href = go(event.target.value)));
  });
})();
