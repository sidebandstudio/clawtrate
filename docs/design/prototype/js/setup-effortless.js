// Behaviour for setup-effortless.html: the screens of docs/design/setup-effortless.md,
// chosen with ?screen=<id>. No program runs and nothing is contacted. Codes,
// addresses and request ids are invented.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  const go = (to, extra = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("screen", to);
    for (const key of ["warn", "tab", "picked", "result"]) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `setup-effortless.html?${next}`;
  };

  const DEVICE = "7C41-D2E0";
  const REQUEST = "7c41d2e0-9a3b-4f0e-8c55-2d6e1b0a9f34";
  const DECOYS = ["B3E9-0A57", "5D2C-81F4"];
  const SCOPES = [
    ["See your bots, tasks and conversations", "operator.read", ""],
    ["Send messages and stop runs", "operator.write", ""],
    ["Answer approval cards", "operator.approvals", ""],
    ["Answer bots' questions", "operator.questions", ""],
    ["Change the gateway's settings, plugins and accounts, and open a terminal on its computer", "operator.admin", "warn"],
    ["Approve and remove other devices", "operator.pairing", "warn"],
  ];
  const FULL_LINE =
    "Clawtrate gets full control of this OpenClaw: your bots, their settings and tools, and which devices may connect.";

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
  const link = (label, to, attrs = "") =>
    `<a class="button" data-size="lg" ${attrs} href="${go(to)}">${label}</a>`;
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
      .map(
        ([words, name, tone]) =>
          `<li${tone ? ` data-tone="${tone}"` : ""}><span>${words}</span><code>${name}</code></li>`,
      )
      .join("") +
    `</ul>`;

  // Screens --------------------------------------------------------------------

  const SCREENS = {
    found: () =>
      brand() +
      `<div class="se-found">` +
      `<p class="se-found-head"><span class="se-dot" aria-hidden="true"></span>OpenClaw is running on this Mac</p>` +
      `<p class="se-found-sub">Port 18789 · default profile · version 2026.10.6</p>` +
      `<a class="button se-wide" data-variant="primary" data-size="lg" href="${go("connecting")}">Connect</a>` +
      `<p class="se-full-line">${FULL_LINE}</p>` +
      `</div>` +
      `<ul class="b-choices" aria-label="Or">` +
      `<li><a class="b-choice" href="${go("another")}"><span class="b-choice-text"><span class="b-choice-title">Another computer</span>` +
      `<span class="b-choice-sub">SSH, an address and token, or a setup code.</span></span>${icon("chevron")}</a></li>` +
      `</ul>`,

    connecting: () =>
      mark() +
      title("Connecting to OpenClaw on this Mac") +
      steps([
        ["Reading OpenClaw's settings", "done"],
        ["Pairing this Mac", "running"],
        ["Loading your bots", "waiting"],
      ]) +
      hint("No Terminal command and no approval: OpenClaw pairs a Mac with itself on its own."),

    another: () => {
      const tab = params.get("tab") || "address";
      const warn = params.get("warn");
      const tabs = [
        ["ssh", "SSH"],
        ["address", "Address and token"],
        ["code", "Setup code"],
      ];
      const address = warn === "ws" ? "ws://192.0.2.10:18789" : warn === "cert" ? "wss://gateway.example" : "wss://gateway.example";
      const panel =
        tab === "ssh"
          ? `<label class="field"><span class="s-field-label">SSH host or alias</span>` +
            `<input class="input" type="text" placeholder="devbox or you@devbox.example" autocomplete="off" spellcheck="false" /></label>` +
            hint("Clawtrate reads OpenClaw's settings there and connects through SSH. No approval.")
          : tab === "code"
            ? `<label class="field"><span class="s-field-label">Setup code</span>` +
              `<textarea class="input se-code" rows="3" placeholder="Paste a setup code" spellcheck="false"></textarea></label>` +
              hint("Made by Clawtrate on another device, or by OpenClaw.")
            : `<label class="field"><span class="s-field-label">Gateway address</span>` +
              `<input class="input" type="text" value="${address}" placeholder="wss://gateway.example" spellcheck="false" /></label>` +
              (warn === "ws"
                ? note(
                    "warn",
                    "",
                    "This connection isn't encrypted. Anyone on the network between you and the gateway can read it, including the token. Use a <code>wss://</code> address or SSH if you can.",
                  )
                : "") +
              (warn === "cert"
                ? note(
                    "warn",
                    "",
                    "Clawtrate can't verify this gateway's certificate. Its fingerprint is <code>SHA-256 AB:12:…:9F</code>. Connect only if this matches the gateway's own.",
                  )
                : "") +
              `<label class="field"><span class="s-field-label">Token</span>` +
              `<input class="input" type="password" value="sample-token-not-real" spellcheck="false" /></label>`;
      const primary =
        tab === "ssh"
          ? "Continue"
          : warn === "ws"
            ? "Connect without encryption"
            : warn === "cert"
              ? "Trust this certificate"
              : "Connect";
      return (
        back("found") +
        mark() +
        title("Another computer") +
        `<div class="se-tabs" role="tablist">` +
        tabs
          .map(
            ([id, label]) =>
              `<a role="tab" class="se-tab" aria-selected="${id === tab}" href="${go("another", { tab: id })}">${label}</a>`,
          )
          .join("") +
        `</div>` +
        panel +
        `<div class="s-actions"><a class="button se-wide" data-variant="primary" data-size="lg" href="${go("waiting")}">${primary}</a></div>` +
        (tab === "ssh" ? "" : `<p class="se-full-line">${FULL_LINE}</p>`)
      );
    },

    waiting: () =>
      back("another") +
      mark() +
      title("Approve this Mac") +
      lede("Waiting for approval from the gateway's owner at <b>gateway.example</b>.") +
      `<p class="s-device" aria-label="This device's code: ${DEVICE.split("").join(" ")}">${DEVICE}</p>` +
      `<p class="se-center se-muted">The approver sees this code.</p>` +
      `<details class="b-disclosure se-asked"><summary>Asked for: full control</summary><div class="b-disclosure-body">${scopeList()}</div></details>` +
      `<ol class="se-ways">` +
      `<li><b>In Clawtrate</b> on a computer or phone already connected to this gateway: it asks you there.</li>` +
      `<li><b>In OpenClaw's Control UI</b> on the gateway's computer, under Devices.</li>` +
      `<li>Or on the gateway's computer, run:<div class="command"><code>openclaw devices approve ${REQUEST}</code>` +
      `<button type="button" class="icon-button copy" aria-label="Copy approve command">${icon("copy")}</button></div></li>` +
      `</ol>` +
      `<p class="se-waiting" role="status">${icon("clock")} Checking every few seconds · <a href="${go("waiting")}">Check now</a></p>`,
  };

  // The approve prompt, drawn over a stand-in for the app.
  const prompt = () => {
    const picked = params.get("picked");
    const result = params.get("result");
    const codes = [DECOYS[0], DEVICE, DECOYS[1]];
    if (result === "approved" || result === "denied" || result === "mismatch") {
      const text = {
        approved: "Approved. The device connects in a moment.",
        denied: "Denied. The device can ask again.",
        mismatch: "Didn't match: nothing was approved.",
      }[result];
      return `<div class="se-toast" role="status">${icon(result === "approved" ? "check" : "warning")}<span>${text}</span></div>`;
    }
    return (
      `<div class="se-scrim"><section class="se-prompt" role="dialog" aria-modal="true" aria-labelledby="se-prompt-title">` +
      `<h2 id="se-prompt-title">Let a new device control this gateway?</h2>` +
      `<div class="se-who">` +
      facts([
        ["Name", `"My iPhone" <span class="se-muted">(reported by the device)</span>`],
        ["Device", "iPhone · Clawtrate"],
        ["From", "192.0.2.24"],
        ["Asked", "12 seconds ago"],
      ]) +
      `</div>` +
      `<h3 class="se-h3">It gets</h3>` +
      scopeList() +
      `<h3 class="se-h3" id="se-code-label">Which code does the new device show?</h3>` +
      `<div class="se-codes" role="radiogroup" aria-labelledby="se-code-label">` +
      codes
        .map(
          (code) =>
            `<a role="radio" class="se-code-choice" aria-checked="${picked === code}" href="${go("approve", code === DEVICE ? { picked: code } : { result: "mismatch" })}">${code}</a>`,
        )
        .join("") +
      `</div>` +
      `<div class="se-prompt-buttons">` +
      `<a class="button" data-size="lg" href="${go("approve", { result: "denied" })}">Deny</a>` +
      (picked === DEVICE
        ? `<a class="button" data-variant="primary" data-size="lg" href="${go("approve", { result: "approved" })}">Approve</a>`
        : `<button type="button" class="button" data-variant="primary" data-size="lg" disabled aria-disabled="true">Approve</button>`) +
      `</div>` +
      `</section></div>`
    );
  };

  const screen = params.get("screen") || "found";
  const card = document.getElementById("setup-card");
  if (screen === "approve") {
    card.innerHTML = SCREENS.found();
    document.getElementById("setup-over").innerHTML = prompt();
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
