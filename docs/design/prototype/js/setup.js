// Behaviour for setup.html: every screen of docs/design/setup.md, one at a time,
// chosen with ?screen=<id> (the list is SCREENS below and in the README). No
// program runs and nothing is contacted: each action goes to the state the
// real one would lead to. The words are the design's own; the check in
// tools/checks/setup.mjs asserts them.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const screen = params.get("screen") || "first";
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Every other setting of the address is kept when moving between screens.
  const go = (to, extra = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("screen", to);
    for (const key of ["open", "slow", "chosen", "play"]) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `setup.html?${next}`;
  };

  // Samples. The fingerprints and the codes are invented; the codes decode to
  // an address and the word "sample", never a token.
  const PRINT = "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8";
  const PRINT_CHANGED = "SHA256:Hb2Wq9Lx Tn4Ce7Ry Mk1Pz5Vd Fs8Ja3Ug Ow6Ni0Ek Tc5";
  const CODE_LAN =
    "eyJ1cmwiOiJ3czovL2RldmJveC5sb2NhbDoxODc4OSIsImJvb3RzdHJhcFRva2VuIjoic2FtcGxlIiwiZXhwaXJlc0F0TXMiOjE3OTUwNTAwMDAwMDB9";
  const REQUEST = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";
  const PHONE_REQUEST = "7c41d2e0-9a3b-4f0e-8c55-2d6e1b0a9f34";

  // Pieces ----------------------------------------------------------------------

  const brand = () =>
    `<header class="connect-brand">` +
    `<img src="../../../packages/ui/src/assets/logo-mark.png" alt="" width="56" height="56" />` +
    `<h1>Clawtrate</h1><p>Your OpenClaw agents, orchestrated.</p></header>`;

  const mark = () => `<img class="s-mark" src="../../../packages/ui/src/assets/logo-mark.png" alt="" width="44" height="44" />`;

  const back = (to, label = "Back") =>
    `<div class="s-top"><a class="button" data-variant="quiet" data-size="sm" href="${go(to)}" data-back>${icon("back")}${label}</a></div>`;

  const title = (text) => `<h2 class="s-title" tabindex="-1" data-s-title>${text}</h2>`;
  const lede = (html) => `<p class="s-lede">${html}</p>`;
  const hint = (html) => `<p class="s-hint">${html}</p>`;

  const button = (label, { variant, to, size = "lg", disabled = false, id, play } = {}) => {
    const attrs = `class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}"${id ? ` id="${id}"` : ""}`;
    if (to && !disabled) return `<a ${attrs} href="${go(to, play ? { play: "1" } : {})}">${label}</a>`;
    return `<button type="button" ${attrs}${disabled ? " disabled" : ""}>${label}</button>`;
  };
  const actions = (...buttons) => `<div class="s-actions">${buttons.join("")}</div>`;

  const note = (tone, lead, text, extra = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""} role="${tone === "danger" ? "alert" : "status"}">` +
    `${icon(tone ? "warning" : "clock")}<div><p>${lead ? `<b>${lead}</b>` : ""}${lead && text ? " " : ""}${text}</p>${extra}</div></div>`;

  const steps = (list) =>
    `<ol class="s-steps" aria-label="Steps">` +
    list
      .map(([text, state, sub, time]) => {
        const markIcon = state === "done" ? icon("check") : state === "failed" ? icon("x") : "";
        const words = { done: "done", running: "running", waiting: "waiting", failed: "failed" }[state];
        return (
          `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${words}">` +
          `<span class="s-step-mark">${markIcon}</span><span>${text}</span>` +
          `<span class="s-step-time">${time || ""}</span>` +
          (sub ? `<span class="s-step-sub">${sub}</span>` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ol>`;

  const facts = (rows) =>
    `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const sentenceFacts = (rows) =>
    `<dl class="s-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;

  const found = (markName, tone, heading, rows, after = "") =>
    `<div class="s-found"><span class="empty-mark"${tone ? ` data-tone="${tone}"` : ""}>${icon(markName)}</span>` +
    `<h3>${heading}</h3>${rows ? facts(rows) : ""}</div>${after}`;

  const copyButton = (label, text) =>
    `<button type="button" class="icon-button copy" aria-label="${label}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const command = (text, label) =>
    `<div class="command"><code>${esc(text)}</code>${copyButton(label, text)}</div><p class="copy-status" aria-live="polite"></p>`;

  const fingerprint = (value) =>
    `<div class="s-print"><div class="s-print-text"><span class="s-print-alg">ED25519</span>` +
    `<code aria-label="${esc(value.replace(/ /g, ", "))}">${value}</code></div>${copyButton("Copy fingerprint", value.replace(/ /g, ""))}</div>`;

  const disclosure = (label, body) =>
    `<details class="b-disclosure s-disclosure"><summary>${label}</summary><div class="b-disclosure-body">${body}</div></details>`;

  const choiceRow = ({ title: t, sub, to, chevron = true, radio, checked, play }) => {
    const inner =
      `<span class="b-choice-text"><span class="b-choice-title">${t}</span>` +
      (sub ? `<span class="b-choice-sub">${sub}</span>` : "") +
      `</span>` +
      (radio ? icon("check").replace('class="icon"', 'class="icon b-tick"') : chevron ? icon("chevron") : "");
    if (radio)
      return `<li><button type="button" class="b-choice" role="radio" aria-checked="${checked ? "true" : "false"}" data-radio>${inner}</button></li>`;
    return `<li><a class="b-choice" href="${go(to, play ? { play: "1" } : {})}">${inner}</a></li>`;
  };

  const dialog = (kind, heading, body, foot, closeTo) =>
    `<div class="s-scrim"><div class="b-dialog" ${kind ? `data-kind="${kind}" ` : ""}role="dialog" aria-modal="true" aria-labelledby="s-dialog-title" open>` +
    `<header class="b-head"><h2 id="s-dialog-title" tabindex="-1" data-s-title>${heading}</h2>` +
    (closeTo ? `<a class="icon-button b-close" href="${go(closeTo)}" aria-label="Close">${icon("x")}</a>` : "") +
    `</header><div class="b-body">${body}</div>${foot ? `<div class="b-foot">${foot}</div>` : ""}</div></div>`;

  // A picture of a QR code, drawn here from the code's characters. The app draws
  // a real one from the code; this one only has the right look.
  function qr(seed) {
    const n = 25;
    let h = 2166136261;
    for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    const rnd = () => ((h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0), h / 4294967296);
    const finder = (x, y) =>
      `<rect x="${x}" y="${y}" width="7" height="7"/><rect x="${x + 1}" y="${y + 1}" width="5" height="5" fill="#fff"/><rect x="${x + 2}" y="${y + 2}" width="3" height="3"/>`;
    const inFinder = (x, y) => (x < 8 && y < 8) || (x > n - 9 && y < 8) || (x < 8 && y > n - 9);
    let cells = "";
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) if (!inFinder(x, y) && rnd() > 0.52) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    return (
      `<div class="s-qr" role="img" aria-label="QR code of the setup code"><svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" fill="#000">` +
      finder(0, 0) + finder(n - 7, 0) + finder(0, n - 7) + cells + `</svg></div>`
    );
  }

  // Screens ---------------------------------------------------------------------

  const readHint = hint("Clawtrate asks for read access. Sending or changing anything is asked for later, once.");
  const runningFacts = (where = "On this computer only") => [
    ["Version", "2026.10.6"],
    ["Listens", where],
    ["Starts", "With the computer"],
  ];
  const howToUpdate = disclosure(
    "How to update",
    command("openclaw update", "Copy update command") +
      `<p class="s-hint">Run it on the gateway's computer when you're ready. Clawtrate doesn't update OpenClaw.</p>`,
  );
  const sshField = (value = "", error = "") =>
    `<label class="field"><span class="s-field-label">SSH host or alias</span>` +
    `<input class="input" id="ssh-host" type="text" placeholder="devbox or you@devbox.example" autocomplete="off" spellcheck="false" value="${esc(value)}" /></label>` +
    (error ? `<p class="s-field-error" id="ssh-error">${error}</p>` : "") +
    hint("Clawtrate uses your SSH settings and keys, and never asks for a password.");

  const SCREENS = {
    first: () =>
      brand() +
      `<h2 class="s-title s-question" tabindex="-1" data-s-title>Where does OpenClaw run?</h2>` +
      `<ul class="b-choices" aria-label="Where does OpenClaw run?">` +
      choiceRow({ title: "This computer", sub: "Clawtrate looks for OpenClaw here.", to: "looking-here", play: true }) +
      choiceRow({
        title: "Another computer",
        sub: "A computer you reach with SSH, such as a server or a desktop at home.",
        to: "there",
      }) +
      `</ul>` +
      `<p class="s-links">${button("Have a setup code?", { variant: "quiet", size: "sm", to: "code" })}${button("Advanced", { variant: "quiet", size: "sm", to: "advanced" })}</p>` +
      hint("New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there."),

    "looking-here": () =>
      back("first") +
      mark() +
      title("Looking on this computer") +
      steps([
        ["Finding OpenClaw", "done"],
        ["Checking its version", "running"],
        ["Asking the gateway", "waiting"],
      ]) +
      (params.get("slow") === "1"
        ? `<p class="s-slow" role="status">Still looking. A gateway that has just started can take a while to answer.</p>`
        : ""),

    found: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", runningFacts()) +
      actions(button("Connect", { variant: "primary", to: "connecting", play: true })) +
      readHint,

    stopped: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("pause", "", "OpenClaw is installed but not running", [
        ["Version", "2026.10.6"],
        ["Starts", "With the computer, but stopped now"],
      ]) +
      actions(button("Start OpenClaw", { variant: "primary", to: "start-confirm" })),

    "start-confirm": () =>
      back("stopped") +
      mark() +
      title("Start OpenClaw on this computer?") +
      lede("The gateway starts as a service and keeps running after Clawtrate closes.") +
      actions(button("Start", { variant: "primary", to: "found" }), button("Cancel", { to: "stopped" })),

    refusing: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found(
        "warning",
        "warn",
        "The gateway here won't let Clawtrate in",
        null,
        `<p class="s-lede">This computer's OpenClaw is set to connect to another gateway.</p>`,
      ) +
      actions(button("Look on another computer", { variant: "primary", to: "there" })),

    notfound: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("plus", "", "OpenClaw isn't on this computer", null) +
      actions(
        button("Set up OpenClaw here", { variant: "primary", to: "install-confirm" }),
        button("It runs on another computer", { variant: "quiet", to: "there" }),
      ),

    older: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", [
        ["Version", "2026.9.37"],
        ["Listens", "On this computer only"],
        ["Starts", "With the computer"],
      ]) +
      note("warn", "", "OpenClaw 2026.9.37 is older than the version this Clawtrate is tested with (2026.10.6). Some things may not work.") +
      actions(button("Connect anyway", { variant: "primary", to: "connecting", play: true })) +
      howToUpdate,

    newer: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", [
        ["Version", "2026.11.4"],
        ["Listens", "On this computer only"],
        ["Starts", "With the computer"],
      ]) +
      note(
        "",
        "",
        "OpenClaw 2026.11.4 is newer than the version this Clawtrate is tested with (2026.10.6). It should work; if something looks wrong, update Clawtrate.",
      ) +
      actions(button("Connect", { variant: "primary", to: "connecting", play: true })),

    tooold: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found(
        "x",
        "danger",
        "This OpenClaw is too old for Clawtrate",
        null,
        `<p class="s-lede">OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again.</p>`,
      ) +
      actions(button("Look again", { variant: "primary", to: "looking-here" })) +
      howToUpdate,

    several: () => {
      const chosen = params.get("chosen");
      return (
        back("first") +
        mark() +
        title("On this computer") +
        found("list", "", "Two gateways run here", null) +
        `<ul class="b-choices" role="radiogroup" aria-label="Gateways">` +
        choiceRow({ title: "OpenClaw · port 18789", sub: "Running · starts with the computer", radio: true, checked: chosen === "1" }) +
        choiceRow({ title: "OpenClaw · port 19001", sub: "Running", radio: true, checked: chosen === "2" }) +
        `</ul>` +
        actions(button("Connect", { variant: "primary", to: "connecting", disabled: !chosen, id: "several-connect" }))
      );
    },

    there: () =>
      back("first") +
      mark() +
      title("Another computer") +
      `<ul class="b-choices s-remembered" aria-label="Computers you used before">` +
      choiceRow({ title: "devbox", sub: "OpenClaw 2026.10.6 · last used today", to: "looking-there", play: true }) +
      `</ul>` +
      `<form id="ssh-form" novalidate>${sshField()}` +
      actions(`<button type="submit" class="button" data-variant="primary" data-size="lg">Look there</button>`) +
      `</form><p class="s-links">${button("Have a setup code instead?", { variant: "quiet", size: "sm", to: "code" })}</p>`,

    "looking-there": () =>
      back("there") +
      mark() +
      title("Looking on devbox") +
      steps([
        ["Reaching devbox", "done"],
        ["Finding OpenClaw", "running"],
        ["Checking its version", "waiting"],
        ["Asking the gateway", "waiting"],
      ]),

    unreachable: () =>
      back("first") +
      mark() +
      title("Another computer") +
      sshField("devbox") +
      note(
        "danger",
        "Can't reach devbox",
        "Nothing answered at devbox.example (connection refused).",
        `<p>Check the name and that the computer is on. A VPN or a jump host goes in your SSH settings.</p>`,
      ) +
      actions(button("Try again", { variant: "primary", to: "looking-there" })),

    refused: () =>
      back("first") +
      mark() +
      title("Another computer") +
      sshField("devbox") +
      note(
        "danger",
        "devbox didn't accept your key",
        "The SSH sign-in for you@devbox.example was refused.",
        `<p>Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first.</p>`,
      ) +
      actions(button("Try again", { variant: "primary", to: "looking-there" })),

    hostkey: () =>
      back("there") +
      mark() +
      title("Is this devbox?") +
      lede("Clawtrate hasn't connected to devbox before. Check that this matches the key the computer shows, then trust it.") +
      fingerprint(PRINT) +
      disclosure(
        "How to check",
        `<p class="s-hint">On devbox, run this and compare the result:</p>` +
          command("ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub", "Copy check command"),
      ) +
      actions(button("Trust and connect", { variant: "primary", to: "found-there" }), button("Back", { to: "there" })),

    "hostkey-changed": () =>
      back("there") +
      mark() +
      title("Another computer") +
      note(
        "danger",
        "devbox's identity has changed",
        "The key devbox sent is not the one trusted before. This can mean someone is between you and that computer, so Clawtrate won't connect. If devbox was reinstalled, remove its old key from your SSH settings, then try again.",
      ) +
      `<p class="s-print-label">The key devbox sent</p>` +
      fingerprint(PRINT_CHANGED) +
      actions(button("Try again", { variant: "primary", to: "looking-there" }), button("Back", { to: "there" })),

    "found-there": () =>
      back("there") +
      mark() +
      title("On devbox") +
      found("check", "ok", "OpenClaw is running", runningFacts("On devbox only")) +
      actions(button("Connect", { variant: "primary", to: "connecting", play: true })) +
      readHint,

    connecting: () =>
      mark() +
      title("Connecting to devbox") +
      steps([
        ["Making a one-time code on devbox", "done"],
        ["Opening a private connection to devbox", "running"],
        ["Connecting", "waiting"],
        ["Loading your bots", "waiting"],
      ]),

    "install-confirm": () =>
      back("notfound") +
      mark() +
      title("Set up OpenClaw on this computer") +
      sentenceFacts([
        ["What", "OpenClaw 2026.10.6, the version this Clawtrate is tested with, and its own copy of Node.js"],
        ["Where", "In Clawtrate's folder, about 830 MB"],
        ["From", "The npm registry and nodejs.org"],
        [
          "Then",
          "A gateway that listens on this computer only, starts with the computer, and has no AI provider yet. You sign in to one when you make your first bot.",
        ],
      ]) +
      hint("Nothing is asked for: no account and no model key.") +
      hint("OpenClaw keeps running if you remove Clawtrate. To remove it too, use Settings first.") +
      actions(button("Download and set up", { variant: "primary", to: "installing", play: true }), button("Cancel", { to: "notfound" })),

    "install-confirm-win": () =>
      back("notfound") +
      mark() +
      title("Set up OpenClaw on this computer") +
      sentenceFacts([
        ["What", "OpenClaw 2026.10.6, the version this Clawtrate is tested with"],
        ["Where", "For every program on this computer, through npm"],
        ["From", "The npm registry, nodejs.org, and Windows Package Manager if Node.js needs updating"],
        [
          "Then",
          "A gateway that listens on this computer only, starts with the computer as a scheduled task, and has no AI provider yet. You sign in to one when you make your first bot.",
        ],
      ]) +
      hint("Nothing is asked for: no account and no model key.") +
      note("", "", "If this computer's Node.js is older than OpenClaw needs, Windows Package Manager updates it for every program.") +
      actions(button("Download and set up", { variant: "primary", to: "installing", play: true }), button("Cancel", { to: "notfound" })),

    installing: () =>
      mark() +
      title("Setting up OpenClaw") +
      steps([
        ["Download OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "running", "Node.js 24.22.1", "0:14"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
        ["Connect", "waiting"],
      ]) +
      actions(button("Cancel", { to: "install-cancel" })),

    "install-failed": () =>
      mark() +
      title("Setting up OpenClaw") +
      steps([
        ["Download OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "failed"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
        ["Connect", "waiting"],
      ]) +
      note("danger", "Install Node.js and OpenClaw failed.", "npm install did not produce a usable OpenClaw package") +
      actions(button("Try again", { variant: "primary", to: "installing" }), button("Cancel", { to: "notfound" })) +
      disclosure(
        "Show details",
        `<pre class="s-details"><code>{"event":"step","name":"node","status":"ok","version":"24.22.1"}\n{"event":"step","name":"openclaw","status":"start","version":"2026.10.6"}\nnpm error code ETARGET\n{"event":"error","message":"npm install did not produce a usable OpenClaw package"}</code></pre>`,
      ),

    "install-cancel": () =>
      SCREENS.installing() +
      dialog(
        "confirm",
        "Stop setting up OpenClaw?",
        `<p class="b-lead">Clawtrate stops and removes what it installed in its folder. Nothing else on this computer was changed.</p>`,
        button("Stop and remove", { variant: "primary", to: "notfound" }) + button("Keep going", { to: "installing" }),
      ),

    advanced: () =>
      back("first") +
      mark() +
      title("Advanced") +
      `<form class="panel" aria-label="Connect to your gateway" novalidate style="margin-top:12px">` +
      `<label class="field"><span class="visually-hidden">Gateway address</span><input class="input" type="text" placeholder="Gateway address" autocomplete="off" spellcheck="false" /></label>` +
      `<label class="field"><span class="visually-hidden">Gateway token, needed for the first pairing only</span><input class="input" type="password" placeholder="Token, for the first pairing only" autocomplete="off" /></label>` +
      `<div class="actions"><button type="button" class="button" data-variant="primary" data-size="lg">Connect</button></div>` +
      `<p class="field-hint">Clawtrate works with an OpenClaw gateway you already run. It asks for read access only, and the token is used once.</p>` +
      `</form>`,

    code: () =>
      back("first") +
      mark() +
      title("Use a setup code") +
      `<label class="field"><span class="s-field-label">Setup code</span>` +
      `<textarea class="s-code-field" id="setup-code" spellcheck="false" placeholder="Paste a code from openclaw qr or from Connect a phone">${CODE_LAN}</textarea></label>` +
      `<p class="s-hint" id="code-where" role="status">Connects to devbox.local, on your network. Expires in 8 minutes.</p>` +
      actions(button("Connect", { variant: "primary", to: "approve" })),

    iphone: () =>
      brand() +
      `<h2 class="s-title s-question" tabindex="-1" data-s-title>Connect to your OpenClaw</h2>` +
      actions(button("Scan a setup code", { variant: "primary", to: "iphone-waiting" }), button("Paste a setup code", { to: "iphone-waiting" })) +
      hint("Make a code in Clawtrate on your computer, in Settings, Connect a phone. Or run openclaw qr on the gateway's computer.") +
      `<p class="s-links">${button("Advanced", { variant: "quiet", size: "sm", to: "advanced" })}</p>`,

    "iphone-waiting": () =>
      back("iphone") +
      mark() +
      title("Waiting for approval") +
      `<p class="s-where">Connects to devbox.tailnet.example, through Tailscale.</p>` +
      lede("Approve this iPhone in Clawtrate on your computer, or run this on the gateway's computer:") +
      command(`openclaw devices approve ${PHONE_REQUEST}`, "Copy approve command") +
      `<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for approval, checking again in 4s</p>`,
  };

  // Screens over the app: the access bar, the strip and Settings. ---------------

  const mockApp = (strip, foot) =>
    `<div class="s-mock"><div class="conversation"><div class="s-mock-title"><span class="s-mock-pill">Disk almost full on the media box</span></div>` +
    (strip || "") +
    `<div class="s-mock-messages" aria-hidden="true"><div class="s-mock-line" style="width:72%"></div><div class="s-mock-line" style="width:54%"></div><div class="s-mock-line" style="width:63%"></div></div></div>` +
    (foot ? `<div class="s-mock-foot">${foot}</div>` : "") +
    `</div>`;

  const accessRequested = () =>
    `<div class="access-bar" role="status"><div class="access-row">${icon("clock")}` +
    `<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span></div>` +
    `<div class="command command-line"><code>openclaw devices approve ${REQUEST}</code>${copyButton("Copy approve command", `openclaw devices approve ${REQUEST}`)}</div>` +
    `<div class="access-row"><span class="access-id">Request e5eb4aa8<span class="access-wait">checking again in 4s</span></span><span class="spacer"></span>` +
    `<a class="button" data-size="sm" href="${go("approve-confirm")}">Approve from here</a>` +
    `<button type="button" class="button" data-variant="quiet" data-size="sm">Check now</button>` +
    `<button type="button" class="button" data-variant="quiet" data-size="sm">Cancel request</button></div></div>`;

  const scopeList = (items) =>
    `<ul class="s-scope-list">${items.map((t) => `<li>${icon("check")}${t}</li>`).join("")}</ul>`;

  const gatewayRows = ({ tailscale = "off", foreign = false } = {}) =>
    `<ul class="s-rows" aria-label="Gateway">` +
    `<li><span class="s-row-text"><span class="s-row-title">Reached through</span><span class="s-row-sub">devbox over SSH · In use</span></span></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">Private access with Tailscale</span>` +
    `<span class="s-row-sub">${
      tailscale === "on"
        ? "On · devbox.tailnet.example"
        : "Reach this gateway from your own devices anywhere, through Tailscale. Tailscale is never needed for anything else."
    }</span></span>` +
    `<button type="button" class="b-switch" role="switch" aria-label="Private access with Tailscale" aria-checked="${tailscale === "on"}"${foreign ? " disabled" : ""} data-tailscale></button></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">Connect a phone</span><span class="s-row-sub">A QR code and a setup code for Clawtrate on your iPhone</span></span>` +
    `<a class="button" data-size="sm" href="${go("phone")}">Connect a phone</a></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">OpenClaw on devbox</span><span class="s-row-sub">Installed by Clawtrate · OpenClaw 2026.10.6 · Starts with the computer</span></span></li>` +
    `<li><a class="button" data-variant="quiet" data-size="sm" href="${go("remove")}">Remove this gateway</a>` +
    `<a class="button s-danger-text" data-variant="quiet" data-size="sm" href="${go("uninstall")}">Remove OpenClaw…</a></li>` +
    `</ul>`;

  const tailscaleFailure = (lead, text, failedStep) =>
    gatewayRows() +
    steps([
      ["Checking Tailscale", failedStep === 0 ? "failed" : "done"],
      ["Turning on private access", failedStep === 0 ? "waiting" : "done"],
      ["Restarting OpenClaw", failedStep === 0 ? "waiting" : "done"],
      ["Checking the address", failedStep === 3 ? "failed" : "waiting"],
    ]) +
    note("warn", lead, text, `<p>The gateway is reachable the way it was.</p>`);

  const phoneBody = ({ request = false, expired = false } = {}) =>
    `<p class="s-where">Works on the same Wi-Fi as this computer.</p>` +
    (expired
      ? `<div class="s-qr-gone"><span class="empty-mark">${icon("clock")}</span></div><p class="s-expiry">This code has expired.</p>`
      : qr(CODE_LAN) +
        `<p class="s-hint">Open Clawtrate on your iPhone and scan this code.</p>` +
        `<div class="s-code">${command(CODE_LAN, "Copy setup code")}</div>` +
        `<p class="s-expiry" aria-live="off">Expires in 9:41</p>`) +
    (request
      ? `<ul class="b-choices s-request" aria-label="Waiting to connect"><li><div class="b-choice">` +
        `<span class="b-choice-text"><span class="b-choice-title">Clawtrate iPhone wants to connect</span>` +
        `<span class="b-choice-sub">Read bots, tasks and conversations</span></span></div></li></ul>` +
        `<div class="b-actions" style="margin-top:10px">${button("Approve", { variant: "primary", size: "sm" })}${button("Not now", { variant: "quiet", size: "sm" })}</div>`
      : "");

  const OVER = {
    approve: () => mockApp("", accessRequested()),
    "approve-confirm": () =>
      mockApp("", accessRequested()) +
      dialog(
        "confirm",
        "Approve on devbox?",
        scopeList(["Send messages and stop runs", "Answer questions", "Approve actions"]) +
          `<p class="b-lead" style="text-align:left">Clawtrate runs OpenClaw's approve command on devbox for request e5eb4aa8.</p>`,
        button("Approve", { variant: "primary", to: "approve" }) + button("Cancel", { to: "approve" }),
      ),
    restoring: () =>
      mockApp(
        `<div class="status-strip" data-tone="warn" role="status"><span class="status-dot"></span>` +
          `<span class="status-strip-text"><b>Restoring the connection to devbox</b><span>· showing saved messages</span></span>` +
          `<button type="button">Retry now</button></div>`,
      ),
    remove: () =>
      mockApp() +
      dialog(
        "confirm",
        "Remove devbox from Clawtrate?",
        `<p class="b-lead" style="text-align:left">Clawtrate disconnects and forgets how to reach it. OpenClaw keeps running on devbox.</p>` +
          `<label class="s-check"><input type="checkbox" /> <span>Also stop OpenClaw on devbox. Clawtrate started it.</span></label>`,
        button("Remove", { variant: "primary", to: "first" }) + button("Cancel", { to: "tailscale" }),
      ),
    uninstall: () =>
      mockApp() +
      dialog(
        "confirm",
        "Remove OpenClaw from this computer?",
        `<p class="b-lead" style="text-align:left">This removes the gateway service, its settings, its bots and their conversations, and the program. It can't be undone.</p>` +
          `<label class="s-check"><input type="checkbox" /> <span>Keep the bots and their conversations</span></label>`,
        `<a class="button" data-variant="primary" data-size="lg" data-danger href="${go("first")}">Remove</a>` + button("Cancel", { to: "tailscale" }),
      ),
    phone: () => mockApp() + dialog("", "Connect a phone", phoneBody(), "", "tailscale"),
    "phone-request": () => mockApp() + dialog("", "Connect a phone", phoneBody({ request: true }), "", "tailscale"),
    "phone-expired": () =>
      mockApp() + dialog("", "Connect a phone", phoneBody({ expired: true }), button("Make a new code", { variant: "primary", to: "phone" }), "tailscale"),
    "phone-loopback": () =>
      mockApp() +
      dialog(
        "",
        "Connect a phone",
        note("warn", "A phone can't reach this gateway yet.", "It only listens on this computer.") +
          actions(button("Turn on private access with Tailscale", { to: "tailscale-confirm" })) +
          hint("Or set OpenClaw to listen on your network (<code>gateway.bind</code>)."),
        "",
        "tailscale",
      ),
    tailscale: () => mockApp() + dialog("settings-lite", "Gateway · devbox", gatewayRows(), "", "first"),
    "tailscale-confirm": () =>
      mockApp() +
      dialog(
        "confirm",
        "Turn on private access?",
        `<p class="b-lead" style="text-align:left">OpenClaw restarts on devbox. Your devices signed in to Tailscale can then reach it at an address like devbox.tailnet.example. Clawtrate reconnects by itself.</p>`,
        button("Turn on", { variant: "primary", to: "tailscale-https" }) + button("Cancel", { to: "tailscale" }),
      ),
    "tailscale-missing": () =>
      mockApp() +
      dialog("settings-lite", "Gateway · devbox", tailscaleFailure("Tailscale isn't installed on devbox.", "Install Tailscale on devbox and sign in, then turn this on again.", 0), "", "first"),
    "tailscale-signedout": () =>
      mockApp() +
      dialog("settings-lite", "Gateway · devbox", tailscaleFailure("Tailscale is signed out on devbox.", "Sign in to Tailscale on devbox, then turn this on again.", 0), "", "first"),
    "tailscale-https": () =>
      mockApp() +
      dialog(
        "settings-lite",
        "Gateway · devbox",
        tailscaleFailure("HTTPS isn't turned on for this tailnet.", "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again.", 3),
        "",
        "first",
      ),
    "tailscale-foreign": () =>
      mockApp() +
      dialog(
        "settings-lite",
        "Gateway · devbox",
        gatewayRows({ foreign: true }) +
          note(
            "warn",
            "A Tailscale route to this gateway already exists.",
            "Clawtrate didn't make it and leaves it alone. OpenClaw refuses connections through it unless its owner sets gateway.trustedProxies.",
          ),
        "",
        "first",
      ),
  };

  // Render ----------------------------------------------------------------------

  const root = document.getElementById("setup-root");
  const card = document.getElementById("setup-card");
  const known = { ...SCREENS, ...OVER };
  const id = known[screen] ? screen : "first";
  root.dataset.screen = id;
  // The iPhone's screens are shown at phone width unless the address says otherwise.
  if (id.startsWith("iphone") && !params.get("width")) {
    CT.settings.width = "phone";
    document.documentElement.dataset.width = "phone";
    document.documentElement.dataset.input = "touch";
  }

  if (OVER[id]) {
    root.innerHTML = OVER[id]();
    root.classList.add("s-over");
  } else {
    card.innerHTML = SCREENS[id]();
  }
  CT.hydrate(root);

  // A wait reached through the flow plays on to what it leads to; reached from
  // the address, it holds, so every state can be looked at.
  const NEXT = {
    "looking-here": "found",
    "looking-there": "found-there",
    connecting: null,
    installing: "connecting",
  };
  if (params.get("play") === "1" && id in NEXT) {
    setTimeout(() => {
      location.href = NEXT[id] ? go(NEXT[id], id === "installing" ? { play: "1" } : {}) : "app.html?state=readonly";
    }, 2400);
  }

  // Focus and announce the screen's title, as the design says.
  const heading = root.querySelector("[data-s-title]");
  const live = document.getElementById("setup-live");
  if (heading) {
    if (params.get("focus") !== "0") heading.focus({ preventScroll: true });
    live.textContent = heading.textContent;
  }

  // The SSH field: a value that is not an SSH destination is refused before
  // anything runs (setup.md section 19).
  const form = document.getElementById("ssh-form");
  if (form) {
    const DESTINATION = /^(?:[A-Za-z0-9._-]{1,64}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("ssh-host");
      const value = input.value.trim();
      form.querySelector(".s-field-error")?.remove();
      if (!DESTINATION.test(value)) {
        input.insertAdjacentHTML(
          "afterend",
          `<p class="s-field-error" id="ssh-error" role="alert">That isn't an SSH host or alias Clawtrate can use.</p>`,
        );
        input.setAttribute("aria-describedby", "ssh-error");
        return input.focus();
      }
      location.href = go(value === "newbox" ? "hostkey" : "looking-there", { play: "1" });
    });
  }

  // A pasted setup code is read here, never sent anywhere.
  const codeField = document.getElementById("setup-code");
  if (codeField) {
    const where = document.getElementById("code-where");
    codeField.addEventListener("input", () => {
      try {
        const json = JSON.parse(atob(codeField.value.trim().replace(/-/g, "+").replace(/_/g, "/")));
        const host = new URL(json.url).hostname;
        // A Tailscale name is reported by the code's own address; the samples use
        // an example domain in place of Tailscale's.
        where.textContent = host.endsWith(".tailnet.example")
          ? `Connects to ${host}, through Tailscale.`
          : `Connects to ${host}, on your network. Expires in 8 minutes.`;
      } catch {
        where.textContent = codeField.value.trim() ? "That isn't a setup code." : "";
      }
    });
  }

  // Radio rows (two gateways): choosing one enables Connect.
  root.querySelectorAll("[data-radio]").forEach((row, index, rows) => {
    row.addEventListener("click", () => {
      rows.forEach((other) => other.setAttribute("aria-checked", String(other === row)));
      const connect = document.getElementById("several-connect");
      if (connect) {
        connect.disabled = false;
        connect.onclick = () => (location.href = go("connecting"));
      }
    });
  });

  // The Tailscale switch asks first.
  root.querySelectorAll("[data-tailscale]").forEach((sw) =>
    sw.addEventListener("click", () => {
      if (!sw.disabled) location.href = go("tailscale-confirm");
    }),
  );

  // Copy says what happened, as on the pairing screen.
  root.addEventListener("click", async (event) => {
    const copy = event.target.closest("[data-copy]");
    if (!copy) return;
    const status = copy.closest(".command")?.nextElementSibling;
    try {
      await navigator.clipboard.writeText(copy.dataset.copy);
      if (status) status.textContent = "Copied.";
    } catch {
      const code = copy.parentElement.querySelector("code");
      const range = document.createRange();
      range.selectNodeContents(code);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      if (status)
        status.textContent = `Selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
    }
  });

  // Escape is Back on a step screen.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const close = root.querySelector(".b-close, .s-scrim .b-foot .button:last-child");
    const backLink = root.querySelector("[data-back]");
    const target = close || backLink;
    if (target?.href) location.href = target.href;
  });

  // The prototype bar: every state, one choice away.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    extra.innerHTML =
      `<label class="proto-seg">State <select id="setup-state" aria-label="Setup state">` +
      Object.keys(known)
        .map((key) => `<option value="${key}"${key === id ? " selected" : ""}>${key}</option>`)
        .join("") +
      `</select></label>`;
    document.getElementById("setup-state").addEventListener("change", (event) => (location.href = go(event.target.value)));
  });

  CT.setupScreens = Object.keys(known);
})();
