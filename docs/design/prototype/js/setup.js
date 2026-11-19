// Behaviour for setup.html: every screen of docs/design/setup.md, chosen with
// ?screen=<id> (SCREENS below; the README lists them). No program runs and
// nothing is contacted. Each action goes where the real one would lead, so
// every path can be walked to its outcome by clicking; a wait reached through
// a click plays on to what it leads to, and from the address it holds.
//
// The host's confirmation is drawn here as a stand-in (.s-host): in the app it
// is a native dialog the page cannot draw or answer. Events that come from
// outside the app (the gateway's owner approving, a phone scanning) are
// buttons in a dashed "Prototype" box, which is not product.

(function () {
  const CT = window.CT;
  const params = CT.params;
  const screen = params.get("screen") || "first";
  const icon = (name) => CT.icon(name);
  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // Every other setting of the address is kept when moving between screens.
  const TRANSIENT = ["slow", "chosen", "play", "host", "next", "to", "keep", "name"];
  const go = (to, extra = {}) => {
    const next = new URLSearchParams(location.search);
    next.set("screen", to);
    for (const key of TRANSIENT) next.delete(key);
    for (const [key, value] of Object.entries(extra)) next.set(key, value);
    return `setup.html?${next}`;
  };
  // The computer typed in the field, carried through the walk (Back keeps it).
  const typed = params.get("name") || "devbox";

  // Samples. Fingerprints, device codes and setup codes are invented; the codes
  // decode to an address and the word "sample", never a token.
  const PRINT = "SHA256:Q3v8Lw0e Xk2Rj9Ta Nf5Hc1Ub Ym7Pd4Gs Zi6Ko2Ea Vr8";
  const PRINT_NEW = "SHA256:Hb2Wq9Lx Tn4Ce7Ry Mk1Pz5Vd Fs8Ja3Ug Ow6Ni0Ek Tc5";
  const CODE_LAN =
    "eyJ1cmwiOiJ3czovL2RldmJveC5sb2NhbDoxODc4OSIsImJvb3RzdHJhcFRva2VuIjoic2FtcGxlIiwiZXhwaXJlc0F0TXMiOjE3OTUwNTAwMDAwMDB9";
  const REQUEST = "e5eb4aa8-175f-40f1-bc7a-8f15cfc40942";
  const PHONE_REQUEST = "7c41d2e0-9a3b-4f0e-8c55-2d6e1b0a9f34";
  const DEVICE = "5AE2-3AFF";
  const PHONE_DEVICE = "7C41-D2E0";
  const FAR_FUTURE = 4102444800000; // 2100: the samples never expire while looked at

  // Pieces ----------------------------------------------------------------------

  const logo = "../../../packages/ui/src/assets/logo-mark.png";
  const brand = () =>
    `<header class="connect-brand"><img src="${logo}" alt="" width="56" height="56" />` +
    `<h1>Clawtrate</h1><p>Your OpenClaw agents, orchestrated.</p></header>`;
  const mark = () => `<img class="s-mark" src="${logo}" alt="" width="44" height="44" />`;
  const back = (to, extra = {}) =>
    `<div class="s-top"><a class="button" data-variant="quiet" data-size="sm" href="${go(to, extra)}" data-back>${icon("back")}Back</a></div>`;
  const title = (text) => `<h2 class="s-title" tabindex="-1" data-s-title>${text}</h2>`;
  const lede = (html) => `<p class="s-lede">${html}</p>`;
  const hint = (html) => `<p class="s-hint">${html}</p>`;

  const button = (label, { variant, to, size = "lg", disabled = false, id, play, extra = {}, host, attrs = "" } = {}) => {
    const base = `class="button"${variant ? ` data-variant="${variant}"` : ""} data-size="${size}"${id ? ` id="${id}"` : ""}${attrs ? ` ${attrs}` : ""}`;
    if (host) return `<button type="button" ${base} data-host="${host}"${disabled ? " disabled" : ""}>${label}</button>`;
    if (to && !disabled) return `<a ${base} href="${go(to, { ...extra, ...(play ? { play: "1" } : {}) })}">${label}</a>`;
    return `<button type="button" ${base}${disabled ? " disabled" : ""}>${label}</button>`;
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
        return (
          `<li data-state="${state}"${state === "running" ? ' aria-current="step"' : ""} aria-label="${esc(text)}, ${state}">` +
          `<span class="s-step-mark">${markIcon}</span><span>${text}</span><span class="s-step-time">${time || ""}</span>` +
          (sub ? `<span class="s-step-sub">${sub}</span>` : "") +
          `</li>`
        );
      })
      .join("") +
    `</ol>`;

  const facts = (rows) => `<dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const sentenceFacts = (rows) =>
    `<dl class="s-facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>`;
  const found = (markName, tone, heading, rows, after = "") =>
    `<div class="s-found"><span class="empty-mark"${tone ? ` data-tone="${tone}"` : ""}>${icon(markName)}</span>` +
    `<h3>${heading}</h3>${rows ? facts(rows) : ""}</div>${after}`;

  const copyButton = (label, text) =>
    `<button type="button" class="icon-button copy" aria-label="${label}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const command = (text, label) =>
    `<div class="command"><code>${esc(text)}</code>${copyButton(label, text)}</div><p class="copy-status" aria-live="polite"></p>`;
  const fingerprint = (label, value) =>
    `<div class="s-print"><div class="s-print-text"><span class="s-print-alg">${label}</span>` +
    `<code aria-label="${esc(value.replace(/ /g, ", "))}">${value}</code></div>${copyButton(`Copy the ${label.toLowerCase()} fingerprint`, value.replace(/ /g, ""))}</div>`;
  const deviceCode = (code, label) =>
    `<p class="s-device" aria-label="${label}: ${code.split("").join(" ")}">${code}</p>`;
  const disclosure = (label, body) =>
    `<details class="b-disclosure s-disclosure"><summary>${label}</summary><div class="b-disclosure-body">${body}</div></details>`;
  const simulate = (label, to, extra = {}) =>
    `<div class="s-simulate" aria-label="Prototype control"><span>Prototype</span><a class="button" data-size="sm" href="${to === "app" ? "app.html?state=readonly" : go(to, extra)}" data-simulate>${label}</a></div>`;
  // The display settings, carried to another page of the prototype.
  const display = () => {
    const kept = new URLSearchParams([...params].filter(([k]) => ["theme", "width", "motion", "chrome"].includes(k)));
    return kept.size ? `?${kept}` : "";
  };

  const choiceRow = ({ title: t, sub, to, radio, checked, extra = {}, play }) => {
    const inner =
      `<span class="b-choice-text"><span class="b-choice-title">${t}</span>${sub ? `<span class="b-choice-sub">${sub}</span>` : ""}</span>` +
      (radio ? icon("check").replace('class="icon"', 'class="icon b-tick"') : icon("chevron"));
    if (radio)
      return `<li><button type="button" class="b-choice" role="radio" aria-checked="${checked ? "true" : "false"}" data-radio>${inner}</button></li>`;
    return `<li><a class="b-choice" href="${go(to, { ...extra, ...(play ? { play: "1" } : {}) })}" data-choice>${inner}</a></li>`;
  };

  const dialog = (kind, heading, body, foot, closeTo) =>
    `<div class="s-scrim"><div class="b-dialog" ${kind ? `data-kind="${kind}" ` : ""}role="dialog" aria-modal="true" aria-labelledby="s-dialog-title" open>` +
    `<header class="b-head"><h2 id="s-dialog-title" tabindex="-1" data-s-title>${heading}</h2>` +
    (closeTo ? `<a class="icon-button b-close" href="${go(closeTo)}" aria-label="Close">${icon("x")}</a>` : "") +
    `</header><div class="b-body">${body}</div>${foot ? `<div class="b-foot">${foot}</div>` : ""}</div></div>`;

  // A picture of a QR code, labelled as a sample: the app draws a real one.
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
      `<div class="s-qr" role="img" aria-label="QR code of the setup code (a sample picture in this prototype)"><span class="s-sample">Sample</span>` +
      `<svg viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" fill="#000">${finder(0, 0)}${finder(n - 7, 0)}${finder(0, n - 7)}${cells}</svg></div>`
    );
  }

  // The host's confirmations ---------------------------------------------------
  // Each: the message, the detail, an optional checkbox that must be ticked,
  // the confirming button's words, and where it leads.

  const HOST = {
    trustKey: {
      message: `Trust ${typed}'s key?`,
      detail: `<p>ED25519 ${PRINT}</p><p>Clawtrate will connect to ${typed} only while it presents this key.</p>`,
      confirm: "Trust",
      to: () => go("looking-there", { play: "1", next: "found-there", name: typed }),
    },
    replaceKey: {
      message: `Replace ${typed}'s trusted key?`,
      detail: `<p>Trusted: ${PRINT}</p><p>Presented now: ${PRINT_NEW}</p>`,
      checkbox: `I checked the new key on ${typed} itself`,
      confirm: "Replace",
      to: () => go("looking-there", { play: "1", next: "found-there", name: typed }),
    },
    start: {
      message: "Start OpenClaw on this computer?",
      detail: "<p>Starts the LaunchAgent ai.openclaw.gateway. It keeps running after Clawtrate closes.</p>",
      confirm: "Start",
      to: () => go("found"),
    },
    install: {
      message: "Set up OpenClaw on this computer?",
      detail:
        "<p>OpenClaw 2026.10.6 and Node.js 24.22.1 are checked against fingerprints built into Clawtrate before anything runs.</p><p>npm then downloads about 345 packages from the npm registry, which Clawtrate can't check.</p>",
      confirm: "Set up",
      to: () => go("installing", { play: "1" }),
    },
    installThere: {
      message: `Set up OpenClaw on ${typed}?`,
      detail: `<p>${typed}.example, which reports its name as ${typed}-1.</p><p>OpenClaw 2026.10.6 and Node.js 24.22.1 are checked against fingerprints built into Clawtrate before anything runs. npm then downloads about 345 packages from the npm registry, which Clawtrate can't check.</p>`,
      confirm: "Set up",
      to: () => go("installing-there", { play: "1", name: typed }),
    },
    cancelInstall: {
      message: "Stop setting up OpenClaw?",
      detail: "<p>Clawtrate stops the installer and removes the folders and the service this setup made. Nothing else is touched.</p>",
      confirm: "Stop and remove",
      to: () => go("notfound"),
    },
    approve: {
      message: "Approve this request on devbox?",
      detail:
        "<p>Gateway: devbox · gateway c5fd-e286, as you on devbox.example.</p><p>Device: Clawtrate Desktop · 5AE2-3AFF, this computer.</p><p>Adds: Send messages and stop runs. Answer questions. Approve actions.</p>",
      confirm: "Approve",
      to: () => go("approve-done"),
    },
    approvePhone: {
      message: "Approve this request on devbox?",
      detail:
        "<p>Gateway: devbox · gateway c5fd-e286, as you on devbox.example.</p><p>Device: iPhone · 7C41-D2E0.</p><p>Adds: Read bots, tasks and conversations.</p>",
      confirm: "Approve",
      to: () => go("phone-done"),
    },
    phoneCode: {
      message: "Make a one-time setup code on devbox?",
      detail: "<p>Anyone who has the code in the next 10 minutes can ask to connect. Nothing connects until you approve it.</p>",
      confirm: "Make the code",
      to: () => go("phone-code"),
    },
    tailscaleOn: {
      message: "Turn on private access on devbox?",
      detail:
        "<p>OpenClaw restarts on devbox and becomes reachable from your devices signed in to Tailscale. If anything fails, Clawtrate puts the setting back as it was and checks that the gateway answers.</p>",
      confirm: "Turn on",
      to: () => go("tailscale-steps", { play: "1" }),
    },
    tailscaleOff: {
      message: "Turn off private access on devbox?",
      detail: "<p>OpenClaw restarts on devbox. Devices using the Tailscale address stop reaching it.</p>",
      confirm: "Turn off",
      to: () => go("tailscale"),
    },
    removeRoute: {
      message: "Remove devbox from Clawtrate?",
      detail: "<p>Clawtrate disconnects, forgets this route and its pinned key, and leaves OpenClaw on devbox running.</p>",
      checkbox: "Also stop OpenClaw on devbox (Clawtrate started it)",
      optional: true,
      confirm: "Remove",
      to: () => go("first"),
    },
    uninstall: {
      message: "Remove OpenClaw from devbox?",
      detail:
        "<p>devbox.example, which reports its name as devbox-1.</p><p>The service ai.openclaw.clawtrate. The program in ~/.local/share/clawtrate/openclaw. The gateway's settings, bots and conversations in ~/.openclaw-clawtrate.</p>",
      confirm: "Remove",
      to: () => go("uninstall-partial"),
    },
  };

  const hostDialog = (op) => {
    const d = HOST[op];
    return (
      `<div class="s-host-scrim" data-host-scrim><div class="s-host" role="alertdialog" aria-modal="true" aria-labelledby="s-host-title" aria-describedby="s-host-detail" data-host-dialog="${op}">` +
      `<p class="s-host-caption">The app's own dialog, not part of the page (a stand-in for the native dialog)</p>` +
      `<div class="s-host-body"><img src="${logo}" alt="" width="40" height="40" /><div>` +
      `<h2 id="s-host-title" tabindex="-1">${d.message}</h2><div id="s-host-detail" class="s-host-detail">${d.detail}</div>` +
      (d.checkbox ? `<label class="s-check"><input type="checkbox" data-host-check /> <span>${d.checkbox}</span></label>` : "") +
      `</div></div><div class="s-host-buttons"><button type="button" class="button" data-size="sm" data-host-cancel>Cancel</button>` +
      `<a class="button" data-variant="primary" data-size="sm" href="${d.to()}" data-host-confirm${d.checkbox && !d.optional ? ' aria-disabled="true"' : ""}>${d.confirm}</a></div></div></div>`
    );
  };

  // Screens -----------------------------------------------------------------------

  const runningFacts = (where = "On this computer only", version = "2026.10.6") => [
    ["Version", version],
    ["Profile", "default"],
    ["Listens", where],
    ["Service", "LaunchAgent, starts when you log in"],
  ];
  const connectHint = hint(
    "Connect pairs this computer with the gateway as a device that can only read, and the gateway keeps it. Sending or changing anything is asked for later.",
  );
  const howToUpdate = disclosure(
    "How to update",
    command("openclaw update", "Copy update command") + `<p class="s-hint">Run it yourself when you're ready.</p>`,
  );
  const sshField = (value = "", error = "") =>
    `<label class="field"><span class="s-field-label">SSH host or alias</span>` +
    `<input class="input" id="ssh-host" name="ssh-host" type="text" placeholder="devbox or you@devbox.example" autocomplete="off" spellcheck="false" value="${esc(value)}" /></label>` +
    (error ? `<p class="s-field-error" id="ssh-error" role="alert">${error}</p>` : "") +
    hint("Clawtrate uses your SSH keys and the host's settings from your SSH configuration, and never asks for a password.");

  const windows = params.get("os") === "windows";

  const SCREENS = {
    first: () =>
      brand() +
      `<h2 class="s-title s-question" tabindex="-1" data-s-title>Where does OpenClaw run?</h2>` +
      `<ul class="b-choices" aria-label="Where does OpenClaw run?" data-choice-list>` +
      choiceRow({ title: "This computer", sub: "Clawtrate looks for OpenClaw here.", to: "looking-here", play: true, extra: windows ? { os: "windows", next: "notfound-windows" } : {} }) +
      choiceRow({ title: "Another computer", sub: "A computer you reach with SSH, such as a server or a desktop at home.", to: "there" }) +
      `</ul>` +
      `<p class="s-links">${button("Have a setup code?", { variant: "quiet", size: "sm", to: "code" })}<a class="button" data-variant="quiet" data-size="sm" href="connect.html${display()}" id="advanced-link">Advanced</a></p>` +
      hint(
        windows
          ? "New to OpenClaw? Choose Another computer to use or set up OpenClaw on a Mac or a Linux computer."
          : "New to OpenClaw? Choose where it should run, and Clawtrate offers to set it up there.",
      ),

    "looking-here": () =>
      back("first") +
      mark() +
      title("Looking on this computer") +
      steps([
        ["Finding OpenClaw", "done"],
        ["Checking its version", "running"],
        ["Asking the gateway", "waiting"],
      ]) +
      (params.get("slow") === "1" ? `<p class="s-slow" role="status">Still looking. A gateway that has just started can take a while to answer.</p>` : ""),

    found: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", runningFacts()) +
      actions(button("Connect", { variant: "primary", to: "connecting-here", play: true })) +
      connectHint,

    "connecting-here": () =>
      back("found") +
      mark() +
      title("Connecting") +
      steps([
        ["Making a one-time code", "done"],
        ["Pairing this computer, read-only", "running"],
        ["Loading your bots", "waiting"],
      ]),

    stopped: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("pause", "", "OpenClaw is installed but not running", [
        ["Version", "2026.10.6"],
        ["Service", "LaunchAgent, stopped"],
      ]) +
      actions(button("Start OpenClaw", { variant: "primary", host: "start" })),

    untested: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("check", "ok", "OpenClaw is running", runningFacts("On this computer only", "2026.9.37")) +
      note(
        "warn",
        "",
        "OpenClaw 2026.9.37 isn't the version this Clawtrate is tested with (2026.10.6). Clawtrate connects read-only, and won't run commands on this computer for you until the versions match.",
      ) +
      actions(button("Connect read-only", { variant: "primary", to: "connecting-here", play: true })) +
      howToUpdate,

    tooold: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("x", "danger", "This OpenClaw is too old for Clawtrate", null, lede("OpenClaw 2026.6.2 speaks an older protocol than Clawtrate needs. Update it, then look again.")) +
      actions(button("Look again", { variant: "primary", to: "looking-here", play: true })) +
      howToUpdate,

    "setup-missing": () =>
      back("first") +
      mark() +
      title("On this computer") +
      found(
        "warning",
        "warn",
        "OpenClaw seems to be set up here, but Clawtrate can't find its program",
        null,
        lede("Clawtrate looked in the usual places. If you installed OpenClaw somewhere else, use Advanced, or run <code>openclaw gateway status</code> here to see where it is."),
      ),

    canttell: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("warning", "warn", "Clawtrate couldn't tell what is on this computer", null, lede("Asking the gateway didn't finish in time.")) +
      actions(button("Look again", { variant: "primary", to: "looking-here", play: true })),

    nottoken: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("warning", "warn", "This gateway uses another way to sign in", null, lede("Clawtrate connects by itself only to gateways that use a token. Use Advanced.")) +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="connect.html">Advanced</a></p>`,

    notfound: () =>
      back("first") +
      mark() +
      title("On this computer") +
      found("plus", "", "OpenClaw isn't on this computer", null) +
      actions(
        button("Set up OpenClaw here", { variant: "primary", to: "install-confirm" }),
        button("It runs on another computer", { variant: "quiet", to: "there" }),
      ) +
      note("", "", "Clawtrate also saw another OpenClaw service here (OpenClaw Gateway (work)). It connects only to the default gateway and its own; use Advanced for others."),

    "notfound-windows": () =>
      back("first", { os: "windows" }) +
      mark() +
      title("On this computer") +
      found(
        "plus",
        "",
        "OpenClaw isn't on this computer",
        null,
        lede("Clawtrate doesn't set OpenClaw up on Windows yet: OpenClaw's Windows installer changes this computer's Node.js, npm and PATH, which Clawtrate won't do for you."),
      ) +
      actions(button("Use another computer", { variant: "primary", to: "there" })) +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="https://docs.openclaw.ai/install" target="_blank" rel="noreferrer noopener">OpenClaw's own install instructions</a></p>`,

    there: () => {
      const returning = params.get("returning") === "1";
      return (
        back("first") +
        mark() +
        title("Another computer") +
        (returning
          ? `<ul class="b-choices s-remembered" aria-label="Computers you used before">` +
            choiceRow({ title: "devbox", sub: "OpenClaw 2026.10.6 · last used today", to: "looking-there", play: true, extra: { next: "found-there", name: "devbox" } }) +
            `</ul>`
          : "") +
        `<form id="ssh-form" novalidate>${sshField(params.get("keep") || "")}` +
        actions(`<button type="submit" class="button" data-variant="primary" data-size="lg">Look there</button>`) +
        `</form><p class="s-links">${button("Have a setup code instead?", { variant: "quiet", size: "sm", to: "code" })}</p>` +
        `<p class="s-proto-hint">Prototype: “newbox” is a first contact, “emptybox” has no OpenClaw, “jumpbox” uses a jump host, anything else is found.</p>`
      );
    },

    "there-config": () =>
      back("there", { keep: typed }) +
      mark() +
      title("Another computer") +
      sshField(typed) +
      note(
        "warn",
        `${typed} is reached through another computer.`,
        `Clawtrate doesn't connect through jump hosts yet. Use a setup code made on ${typed}, or Advanced.`,
      ) +
      actions(button("Use a setup code", { variant: "primary", to: "code" })),

    "looking-there": () =>
      back("there", { keep: typed }) +
      mark() +
      title(`Looking on ${typed}`) +
      steps([
        [`Reaching ${typed}`, "done"],
        ["Finding OpenClaw", "running"],
        ["Checking its version", "waiting"],
        ["Asking the gateway", "waiting"],
      ]),

    unreachable: () =>
      back("there", { keep: typed }) +
      mark() +
      title("Another computer") +
      sshField(typed) +
      note("danger", `Can't reach ${typed}`, `Nothing answered at ${typed}.example (connection refused).`, `<p>Check the name and that the computer is on.</p>`) +
      actions(button("Try again", { variant: "primary", to: "looking-there", play: true, extra: { next: "found-there", name: typed } })),

    refused: () =>
      back("there", { keep: typed }) +
      mark() +
      title("Another computer") +
      sshField(typed) +
      note(
        "danger",
        `${typed} didn't accept your key`,
        `The SSH sign-in for you@${typed}.example was refused.`,
        `<p>Check that your key is on that computer. A key with a passphrase has to be in your SSH agent first.</p>`,
      ) +
      actions(button("Try again", { variant: "primary", to: "looking-there", play: true, extra: { next: "found-there", name: typed } })),

    hostkey: () =>
      back("there", { keep: typed }) +
      mark() +
      title(`Is this ${typed}?`) +
      lede(`This is the first time Clawtrate connects to ${typed}. Its key is below. If you can, compare it with the key ${typed} itself shows before you trust it.`) +
      fingerprint("ED25519", PRINT) +
      disclosure(
        "How to compare",
        `<p class="s-hint">On ${typed}, in a session you already trust, <code>ssh-keygen -lf</code> with the key file shows its fingerprint. The file depends on the key's type, for example <code>/etc/ssh/ssh_host_ed25519_key.pub</code>.</p>`,
      ) +
      actions(button("Trust this key…", { variant: "primary", host: "trustKey" }), button("Back", { to: "there", extra: { keep: typed } })),

    "hostkey-changed": () =>
      back("there", { keep: typed }) +
      mark() +
      title("Another computer") +
      note(
        "danger",
        `${typed}'s key has changed`,
        `The key ${typed} presented is not the one Clawtrate trusted. This happens when a computer is reinstalled, and it is also what someone between you and ${typed} would cause. Clawtrate won't connect until you decide.`,
      ) +
      `<div class="s-prints">${fingerprint("Trusted", PRINT)}${fingerprint("Presented now", PRINT_NEW)}</div>` +
      `<p class="s-print-label">Trusted since 3 November</p>` +
      actions(button("Try again", { variant: "primary", to: "looking-there", play: true, extra: { next: "hostkey-changed", name: typed } }), button("Back", { to: "there" })) +
      `<p class="s-links">${button("Replace the trusted key…", { variant: "quiet", size: "sm", host: "replaceKey" })}</p>`,

    "found-there": () =>
      back("there", { keep: typed }) +
      mark() +
      title(`On ${typed}`) +
      found("check", "ok", "OpenClaw is running", [
        ["Version", "2026.10.6"],
        ["Profile", "default"],
        ["Listens", `On ${typed} only`],
        ["Service", "systemd user service, starts with your session"],
      ]) +
      actions(button("Connect", { variant: "primary", to: "connecting-there", play: true, extra: { name: typed } })) +
      connectHint,

    "connecting-there": () =>
      back("found-there", { name: typed }) +
      mark() +
      title(`Connecting to ${typed}`) +
      steps([
        [`Making a one-time code on ${typed}`, "done"],
        [`Opening a private connection to ${typed}`, "running"],
        ["Pairing this computer, read-only", "waiting"],
        ["Loading your bots", "waiting"],
      ]),

    "notfound-there": () =>
      back("there", { keep: typed }) +
      mark() +
      title(`On ${typed}`) +
      found("plus", "", `OpenClaw isn't on ${typed}`, null) +
      actions(button(`Set up OpenClaw on ${typed}`, { variant: "primary", to: "install-confirm-there", extra: { name: typed } })),

    "install-confirm": () =>
      back("notfound") +
      mark() +
      title("Set up OpenClaw on this computer") +
      sentenceFacts([
        ["What", "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1"],
        ["Where", "Its own folders: the program in Clawtrate's folder, the gateway's data in ~/.openclaw-clawtrate. An OpenClaw you already have isn't touched."],
        ["Checked", "OpenClaw and Node.js are checked against fingerprints built into this Clawtrate before anything runs."],
        ["Not checked", "npm then downloads about 345 packages OpenClaw uses from the npm registry. Clawtrate can't check those."],
        [
          "Then",
          "A gateway that listens on this computer only, as a LaunchAgent that starts when you log in, with no AI provider yet. You sign in to one when you make your first bot.",
        ],
      ]) +
      hint("Nothing is asked for: no account and no model key.") +
      hint("OpenClaw keeps running if you remove Clawtrate. Remove it in Settings first if you want it gone.") +
      actions(button("Set up OpenClaw…", { variant: "primary", host: "install" }), button("Cancel", { to: "notfound" })),

    "install-confirm-there": () =>
      back("notfound-there", { name: typed }) +
      mark() +
      title(`Set up OpenClaw on ${typed}`) +
      sentenceFacts([
        ["What", "OpenClaw 2026.10.6, the version this Clawtrate is tested with, with its own copy of Node.js 24.22.1"],
        ["Where", `~/.local/share/clawtrate/openclaw and ~/.openclaw-clawtrate on ${typed}. An OpenClaw already there isn't touched.`],
        ["Checked", "OpenClaw and Node.js are checked against fingerprints built into this Clawtrate before anything runs."],
        ["Not checked", "npm then downloads about 345 packages OpenClaw uses from the npm registry. Clawtrate can't check those."],
        [
          "Then",
          `A gateway that listens on ${typed} only, as a systemd user service that starts with your session, with no AI provider yet. You sign in to one when you make your first bot.`,
        ],
      ]) +
      hint("Nothing is asked for: no account and no model key.") +
      actions(button("Set up OpenClaw…", { variant: "primary", host: "installThere" }), button("Cancel", { to: "notfound-there", extra: { name: typed } })),

    installing: () =>
      mark() +
      title("Setting up OpenClaw") +
      steps([
        ["Download and check OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "running", "Node.js 24.22.1, checked", "0:14"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
        ["Connect", "waiting"],
      ]) +
      hint("The times are samples.") +
      actions(button("Cancel", { host: "cancelInstall" })),

    "installing-there": () =>
      mark() +
      title("Setting up OpenClaw") +
      `<p class="s-where">On ${typed}</p>` +
      steps([
        ["Download and check OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "running", "OpenClaw 2026.10.6, 345 packages", "0:21"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
        ["Connect", "waiting"],
      ]) +
      hint("The times are samples.") +
      actions(button("Cancel", { host: "cancelInstall" })),

    "install-failed": () =>
      mark() +
      title("Setting up OpenClaw") +
      steps([
        ["Download and check OpenClaw 2026.10.6", "done"],
        ["Install Node.js and OpenClaw", "failed"],
        ["Set up the gateway", "waiting"],
        ["Start and check", "waiting"],
        ["Connect", "waiting"],
      ]) +
      note("danger", "Install Node.js and OpenClaw failed.", "The installer didn't use the checked Node.js.") +
      actions(button("Try again", { variant: "primary", to: "installing", play: true }), button("Cancel", { host: "cancelInstall" })) +
      disclosure("Show details", sentenceFacts([["Step", "Install Node.js and OpenClaw"], ["Exit status", "1"], ["Last installer event", "node: start, version 24.22.1"]])),
  };

  // Screens over the app: the access bar, the strip, Settings and the phone. -----

  const mockApp = (strip, foot) =>
    `<div class="s-mock"><div class="conversation"><div class="s-mock-title"><span class="s-mock-pill">Disk almost full on the media box</span></div>` +
    (strip || "") +
    `<div class="s-mock-messages" aria-hidden="true"><div class="s-mock-line" style="width:72%"></div><div class="s-mock-line" style="width:54%"></div><div class="s-mock-line" style="width:63%"></div></div></div>` +
    (foot ? `<div class="s-mock-foot">${foot}</div>` : "") +
    `</div>`;

  const accessRequested = (untested = false) =>
    `<div class="access-bar" role="status" data-s-title tabindex="-1"><div class="access-row">${icon("clock")}` +
    `<span class="shelf-text"><b>Waiting for the gateway's owner.</b> ${untested ? "Run this on devbox." : "Approve this request on the gateway's machine:"}</span></div>` +
    `<div class="command command-line"><code>openclaw devices approve ${REQUEST}</code>${copyButton("Copy approve command", `openclaw devices approve ${REQUEST}`)}</div>` +
    (untested ? "" : `<p class="s-check-first">Check that the request is yours: this computer's device code is ${DEVICE}.</p>`) +
    `<div class="access-row"><span class="access-id">Request e5eb4aa8<span class="access-wait">checking again in 4s</span></span><span class="spacer"></span>` +
    (untested ? "" : `<button type="button" class="button" data-size="sm" data-host="approve">Approve from here</button>`) +
    `<button type="button" class="button" data-variant="quiet" data-size="sm">Check now</button>` +
    `<button type="button" class="button" data-variant="quiet" data-size="sm">Cancel request</button></div></div>`;

  const gatewayRows = ({ tailscale = "off", disabled = false, sub } = {}) =>
    `<ul class="s-rows" aria-label="Gateway">` +
    `<li><span class="s-row-text"><span class="s-row-title">Reached through</span><span class="s-row-sub">devbox over SSH · In use</span></span></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">Private access with Tailscale</span><span class="s-row-sub" id="ts-sub">${
      sub ??
      (tailscale === "on"
        ? "On · devbox.tailnet.example · checked on devbox"
        : "Reach this gateway from your own devices anywhere, through Tailscale. Tailscale is never needed for anything else.")
    }</span></span>` +
    `<button type="button" class="b-switch" role="switch" aria-label="Private access with Tailscale" aria-describedby="ts-sub" aria-checked="${tailscale === "on"}"${disabled ? " disabled" : ""} data-host="${tailscale === "on" ? "tailscaleOff" : "tailscaleOn"}"></button></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">Connect a phone</span><span class="s-row-sub">A one-time code for Clawtrate on your iPhone</span></span>` +
    `<a class="button" data-size="sm" href="${go("phone")}">Connect a phone</a></li>` +
    `<li><span class="s-row-text"><span class="s-row-title">OpenClaw on devbox</span><span class="s-row-sub">Installed by Clawtrate · OpenClaw 2026.10.6 · systemd user service openclaw-gateway-clawtrate.service</span></span></li>` +
    `<li><button type="button" class="button" data-variant="quiet" data-size="sm" data-host="removeRoute">Remove this gateway…</button>` +
    `<a class="button s-danger-text" data-variant="quiet" data-size="sm" href="${go("uninstall")}">Remove OpenClaw…</a></li>` +
    `</ul>`;

  const settings = (body) => mockApp() + dialog("settings-lite", "Gateway · devbox", body, "", "first");

  const tailscaleFailure = (lead, text, outcome, failedStep) =>
    gatewayRows() +
    steps([
      ["Checking Tailscale", failedStep === 0 ? "failed" : "done"],
      ["Turning on private access", failedStep === 0 ? "waiting" : "done"],
      ["Restarting OpenClaw", failedStep === 0 ? "waiting" : "done"],
      ["Checking the new address", failedStep === 3 ? "failed" : "waiting"],
      ["Checking the connection here", "waiting"],
    ]) +
    note("warn", lead, text, `<p>${outcome}</p>`);

  const phoneWhere = `<p class="s-where">This code leads to devbox.local on your local network. The connection isn't encrypted until the phone is paired; use it only on a network you trust.</p>`;
  const phoneCode = (rows = "") =>
    phoneWhere +
    qr(CODE_LAN) +
    hint("Open Clawtrate on your iPhone and scan this code.") +
    `<div class="s-code">${command(CODE_LAN, "Copy setup code")}</div>` +
    `<p class="s-expiry" aria-live="off">Expires at 20:41 (in 9 minutes)</p>` +
    rows;
  const phoneRow = ({ more = false } = {}) =>
    `<p class="s-check-first">Check that the device code matches the one on your iPhone.</p>` +
    `<ul class="b-choices s-request" aria-label="Asking to connect"><li><div class="b-choice">` +
    `<span class="b-choice-text"><span class="b-choice-title">iPhone · ${PHONE_DEVICE}</span>` +
    `<span class="b-choice-sub">${more ? "Asks for more than read access. Clawtrate won't approve it here." : "Asks to read bots, tasks and conversations"}</span></span></div></li></ul>` +
    (more
      ? ""
      : `<div class="b-actions" style="margin-top:10px"><button type="button" class="button" data-variant="primary" data-size="sm" data-host="approvePhone">Approve…</button>${button("Not now", { variant: "quiet", size: "sm", to: "phone-code" })}</div>`);

  const OVER = {
    approve: () => mockApp("", accessRequested()),
    "approve-untested": () => mockApp("", accessRequested(true)),
    "approve-done": () =>
      mockApp(
        `<div class="status-strip" data-tone="ok" role="status" data-s-title tabindex="-1"><span class="status-dot"></span><span class="status-strip-text"><b>Access granted</b><span>· you can send, stop and answer</span></span></div>`,
        `<div class="s-composer" aria-label="Message">Message Otto</div>`,
      ),
    restoring: () =>
      mockApp(
        `<div class="status-strip" data-tone="warn" role="status" data-s-title tabindex="-1"><span class="status-dot"></span>` +
          `<span class="status-strip-text"><b>Restoring the connection to devbox</b><span>· showing saved messages</span></span><button type="button">Retry now</button></div>`,
      ),
    "route-changed": () =>
      mockApp(
        `<div class="status-strip" data-tone="danger" role="status" data-s-title tabindex="-1"><span class="status-dot"></span>` +
          `<span class="status-strip-text"><b>This address now leads to a different gateway</b><span>· disconnected</span></span><a class="s-strip-link" href="${go("there")}">Review</a></div>`,
      ),
    uninstall: () => {
      const keep = params.get("keep") === "1";
      return (
        mockApp() +
        dialog(
          "",
          "Remove OpenClaw from devbox?",
          `<p class="b-lead" style="text-align:left">devbox.example, which reports its name as devbox-1.</p>` +
            `<ul class="s-remove-list"><li>The service ai.openclaw.clawtrate</li><li>The program in ~/.local/share/clawtrate/openclaw</li>` +
            `<li${keep ? ' class="s-kept"' : ""}>The gateway's settings, bots and conversations in ~/.openclaw-clawtrate</li></ul>` +
            `<label class="s-check"><input type="checkbox" id="keep-data"${keep ? " checked" : ""} /> <span>Keep the gateway's settings, bots and conversations</span></label>`,
          `<button type="button" class="button" data-variant="primary" data-size="lg" data-danger data-host="uninstall">Remove…</button>` +
            button("Cancel", { to: "tailscale" }),
          "tailscale",
        )
      );
    },
    "uninstall-partial": () =>
      mockApp() +
      dialog(
        "",
        "Remove OpenClaw from devbox?",
        note("", "OpenClaw is removed.", "macOS moved its service file to your Trash.") +
          note("warn", "Part of OpenClaw is still on devbox:", "", `<p>The log file ~/Library/Logs/openclaw/gateway-clawtrate.log</p>`),
        button("Done", { variant: "primary", to: "first" }),
        "first",
      ),
    phone: () =>
      mockApp() +
      dialog(
        "",
        "Connect a phone",
        lede("Make a one-time code that Clawtrate on your iPhone can scan. It works once, for 10 minutes, and it can only ask to read."),
        `<button type="button" class="button" data-variant="primary" data-size="lg" data-host="phoneCode">Make a code…</button>`,
        "tailscale",
      ),
    "phone-code": () =>
      mockApp() +
      dialog("", "Connect a phone", phoneCode(`<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for the phone</p>`) + simulate("The iPhone scans the code", "phone-request"), "", "tailscale"),
    "phone-request": () => mockApp() + dialog("", "Connect a phone", phoneCode(phoneRow()), "", "tailscale"),
    "phone-overreach": () => mockApp() + dialog("", "Connect a phone", phoneCode(phoneRow({ more: true })), "", "tailscale"),
    "phone-done": () =>
      mockApp() +
      dialog("", "Connect a phone", `<div class="s-found"><span class="empty-mark" data-tone="ok">${icon("check")}</span><h3 tabindex="-1">iPhone connected, read-only.</h3></div>`, button("Done", { variant: "primary", to: "tailscale" }), "tailscale"),
    "phone-expired": () =>
      mockApp() +
      dialog(
        "",
        "Connect a phone",
        `<div class="s-qr-gone"><span class="empty-mark">${icon("clock")}</span></div><p class="s-expiry">This code has expired.</p>`,
        `<button type="button" class="button" data-variant="primary" data-size="lg" data-host="phoneCode">Make a new code…</button>`,
        "tailscale",
      ),
    "phone-loopback": () =>
      mockApp() +
      dialog(
        "",
        "Connect a phone",
        note("warn", "A phone can't reach this gateway yet.", "It only listens on devbox itself.") +
          actions(button("Turn on private access with Tailscale", { to: "tailscale" })) +
          `<p class="s-hint" style="text-align:left">Or let OpenClaw listen on your local network. Run these on devbox yourself:</p>` +
          command("openclaw config set gateway.bind lan", "Copy the first command") +
          command("openclaw gateway restart", "Copy the second command") +
          `<p class="s-hint" style="text-align:left">Anyone on that network can then reach the gateway's sign-in; it still needs a token or a pairing. Clawtrate doesn't change the gateway's bind for you.</p>`,
        "",
        "tailscale",
      ),
    tailscale: () => settings(gatewayRows()),
    "tailscale-steps": () =>
      settings(
        gatewayRows({ sub: "Turning on…", disabled: true }) +
          steps([
            ["Checking Tailscale", "done"],
            ["Turning on private access", "done"],
            ["Restarting OpenClaw", "done"],
            ["Checking the new address", "running"],
            ["Checking the connection here", "waiting"],
          ]),
      ),
    "tailscale-on": () => settings(gatewayRows({ tailscale: "on" })),
    "tailscale-missing": () =>
      settings(tailscaleFailure("Tailscale isn't installed on devbox.", "Install Tailscale on devbox and sign in, then turn this on again.", "Nothing was changed.", 0)),
    "tailscale-stopped": () =>
      settings(tailscaleFailure("Tailscale is stopped on devbox.", "Start Tailscale on devbox, then turn this on again.", "Nothing was changed.", 0)),
    "tailscale-signedout": () =>
      settings(tailscaleFailure("Tailscale is signed out on devbox.", "Sign in to Tailscale on devbox, then turn this on again.", "Nothing was changed.", 0)),
    "tailscale-operator": () =>
      settings(
        tailscaleFailure("OpenClaw can't use Tailscale on devbox.", "On devbox, run <code>sudo tailscale set --operator=$USER</code> yourself, then turn this on again.", "Nothing was changed.", 0),
      ),
    "tailscale-https": () =>
      settings(
        tailscaleFailure(
          "HTTPS isn't turned on for this tailnet.",
          "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again.",
          "The setting is back as it was, and the gateway answers again.",
          3,
        ),
      ),
    "tailscale-unconfirmed": () =>
      settings(
        tailscaleFailure(
          "HTTPS isn't turned on for this tailnet.",
          "Turn on HTTPS certificates in your Tailscale admin console, then turn this on again.",
          "The setting is back as it was, but the gateway hasn't answered yet. Clawtrate keeps checking.",
          3,
        ),
      ),
    "tailscale-foreign": () =>
      settings(
        gatewayRows({ disabled: true }) +
          note(
            "warn",
            "A Tailscale route to this gateway already exists.",
            "Clawtrate didn't make it and leaves it alone. OpenClaw refuses connections through it unless its owner sets gateway.trustedProxies.",
          ),
      ),
    "tailscale-outside": () => settings(gatewayRows({ tailscale: "on", disabled: true, sub: "On, set outside Clawtrate. Change it on devbox." })),
  };

  // The desktop's pasted code and the iPhone's screens, in the column. -------------

  Object.assign(SCREENS, {
    code: () =>
      back("first") +
      mark() +
      title("Use a setup code") +
      `<label class="field"><span class="s-field-label">Setup code</span>` +
      `<textarea class="s-code-field" id="setup-code" spellcheck="false" placeholder="Paste a code from openclaw qr or from Connect a phone"></textarea></label>` +
      `<p class="s-hint" id="code-where" role="status"></p>` +
      actions(`<a class="button" data-variant="primary" data-size="lg" id="code-connect" aria-disabled="true">Connect</a>`) +
      `<p class="s-proto-hint">Prototype: paste a sample code to see it read. <button type="button" class="button" data-size="sm" data-sample-code>Paste a sample code</button></p>`,

    "code-pairing": () =>
      back("code") +
      mark() +
      title("Approve this device") +
      lede("devbox.local has not seen this device before. Approve it once on the gateway's machine and Clawtrate connects by itself.") +
      command(`openclaw devices approve ${REQUEST}`, "Copy approve command") +
      `<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for approval, checking again in 4s</p>` +
      `<ul class="scopes"><li>${icon("read")}Read bots, tasks and conversations</li></ul>` +
      `<p class="connect-foot">Request e5eb4aa8 · this computer's device code ${DEVICE}</p>` +
      simulate("The gateway's owner approves", "app"),

    iphone: () =>
      brand() +
      `<h2 class="s-title s-question" tabindex="-1" data-s-title>Connect to your OpenClaw</h2>` +
      actions(
        button("Scan a setup code", { variant: "primary", to: "iphone-review" }),
        button("Paste a setup code", { to: "iphone-review" }),
      ) +
      hint("Make a code in Clawtrate on your computer, in Settings, Connect a phone.") +
      `<p class="s-links"><a class="button" data-variant="quiet" data-size="sm" href="connect.html?width=phone">Advanced</a></p>`,

    "iphone-review": () =>
      back("iphone") +
      mark() +
      title("Connect to devbox?") +
      `<p class="s-where">This code leads to devbox.tailnet.example, through Tailscale. Your phone needs Tailscale on.</p>` +
      `<p class="s-expiry">Expires at 20:41 (in 9 minutes)</p>` +
      actions(button("Connect", { variant: "primary", to: "iphone-waiting" }), button("Cancel", { to: "iphone" })),

    "iphone-waiting": () =>
      back("iphone-review") +
      mark() +
      title("Waiting for approval") +
      lede("Approve this iPhone in Clawtrate on your computer. Its device code is:") +
      deviceCode(PHONE_DEVICE, "This iPhone's device code") +
      `<p class="s-hint">Or, on the gateway's computer, run:</p>` +
      command(`openclaw devices approve ${PHONE_REQUEST}`, "Copy approve command") +
      `<p class="waiting" role="status"><span class="status-dot" data-status="connecting"></span>Waiting for approval, checking again in 4s</p>` +
      simulate("The gateway's owner approves", "iphone-done"),

    "iphone-done": () =>
      mark() +
      title("Connected, read-only") +
      lede("Clawtrate on this iPhone can read your bots, tasks and conversations. Sending or changing anything is asked for later.") +
      actions(`<a class="button" data-variant="primary" data-size="lg" href="app.html?state=readonly&width=phone">Open Clawtrate</a>`),
  });

  // Render ------------------------------------------------------------------------

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

  // The host's dialog, opened from a button with data-host (or ?host= for a picture).
  const openHost = (op, opener) => {
    if (!HOST[op]) return;
    document.querySelector("[data-host-scrim]")?.remove();
    const app = document.getElementById("root");
    app.insertAdjacentHTML("beforeend", hostDialog(op));
    for (const el of app.children) if (!el.hasAttribute("data-host-scrim")) el.inert = true;
    const scrim = app.querySelector("[data-host-scrim]");
    CT.hydrate(scrim);
    const confirm = scrim.querySelector("[data-host-confirm]");
    const check = scrim.querySelector("[data-host-check]");
    if (check && confirm.hasAttribute("aria-disabled")) {
      check.addEventListener("change", () => {
        if (check.checked) confirm.removeAttribute("aria-disabled");
        else confirm.setAttribute("aria-disabled", "true");
      });
    }
    confirm.addEventListener("click", (event) => {
      if (confirm.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
    const close = () => {
      scrim.remove();
      for (const el of app.children) el.inert = false;
      (opener || root.querySelector("[data-s-title]"))?.focus();
    };
    scrim.querySelector("[data-host-cancel]").addEventListener("click", close);
    scrim.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
      if (event.key === "Tab") {
        // Focus stays inside the dialog.
        const items = [...scrim.querySelectorAll("button, a[href], input")];
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) (event.preventDefault(), last.focus());
        else if (!event.shiftKey && document.activeElement === last) (event.preventDefault(), first.focus());
      }
    });
    scrim.querySelector("#s-host-title").focus();
  };
  root.addEventListener("click", (event) => {
    const opener = event.target.closest("[data-host]");
    if (opener && !opener.disabled) openHost(opener.dataset.host, opener);
  });

  CT.hydrate(root);

  // Focus and announce the screen's title, as the design says.
  const heading = root.querySelector("[data-s-title]");
  const live = document.getElementById("setup-live");
  if (heading) {
    if (params.get("focus") !== "0") heading.focus({ preventScroll: true });
    live.textContent = heading.textContent;
  }
  if (params.get("host")) openHost(params.get("host"));

  // A wait reached through the flow plays on to what it leads to; reached from
  // the address it holds, so every state can be looked at.
  const NEXT = {
    "looking-here": params.get("next") || "found",
    "looking-there": params.get("next") || "found-there",
    "connecting-here": "app",
    "connecting-there": "app",
    installing: "connecting-here",
    "installing-there": "connecting-there",
    "tailscale-steps": "tailscale-on",
  };
  if (params.get("play") === "1" && id in NEXT) {
    setTimeout(() => {
      const to = NEXT[id];
      location.href = to === "app" ? "app.html?state=readonly" : go(to, { ...(to.startsWith("connecting") ? { play: "1" } : {}), name: typed, ...(windows ? { os: "windows" } : {}) });
    }, 2400);
  }

  // The SSH field: a value that is not an SSH destination is refused before
  // anything runs (setup.md section 19). The samples choose the walk.
  const form = document.getElementById("ssh-form");
  if (form) {
    const DESTINATION = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,63}@)?[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const input = document.getElementById("ssh-host");
      const value = input.value.trim();
      form.querySelector(".s-field-error")?.remove();
      if (!DESTINATION.test(value)) {
        input.insertAdjacentHTML("afterend", `<p class="s-field-error" id="ssh-error" role="alert">That isn't an SSH host or alias Clawtrate can use.</p>`);
        input.setAttribute("aria-describedby", "ssh-error");
        return input.focus();
      }
      const host = value.split("@").pop().split(".")[0];
      if (host === "newbox") location.href = go("hostkey", { name: host });
      else if (host === "jumpbox") location.href = go("there-config", { name: host });
      else location.href = go("looking-there", { play: "1", name: host, next: host === "emptybox" ? "notfound-there" : "found-there" });
    });
  }

  // A pasted setup code is read in the host (here, in the page), never sent
  // anywhere before Connect, and its token is never shown.
  const codeField = document.getElementById("setup-code");
  if (codeField) {
    const where = document.getElementById("code-where");
    const connect = document.getElementById("code-connect");
    const allow = (ok) => {
      if (ok) {
        connect.removeAttribute("aria-disabled");
        connect.href = go("code-pairing");
      } else {
        connect.setAttribute("aria-disabled", "true");
        connect.removeAttribute("href");
      }
    };
    const read = () => {
      const text = codeField.value.trim();
      if (!text) return ((where.textContent = ""), allow(false));
      try {
        if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new Error("shape");
        const json = JSON.parse(atob(text.replace(/-/g, "+").replace(/_/g, "/")));
        const url = new URL(json.url);
        if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || (url.pathname && url.pathname !== "/")) throw new Error("address");
        if (typeof json.expiresAtMs !== "number" || json.expiresAtMs <= Date.now()) {
          where.textContent = "This code has expired. Make a new one on the gateway's computer.";
          return allow(false);
        }
        if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
          where.textContent = `This code leads to the computer it was made on, ${url.hostname}. It works only there.`;
          return allow(false);
        }
        where.textContent =
          url.protocol === "wss:"
            ? `Connects to ${url.hostname}, over an encrypted connection. Expires at 20:41.`
            : `Connects to ${url.hostname} on your local network, unencrypted until paired. Expires at 20:41.`;
        allow(true);
      } catch {
        where.textContent = "That isn't a setup code Clawtrate can use.";
        allow(false);
      }
    };
    codeField.addEventListener("input", read);
    root.querySelector("[data-sample-code]")?.addEventListener("click", () => {
      codeField.value = btoa(JSON.stringify({ url: "ws://devbox.local:18789", bootstrapToken: "sample", expiresAtMs: FAR_FUTURE }))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
      read();
    });
    connect.addEventListener("click", (event) => {
      if (connect.getAttribute("aria-disabled") === "true") event.preventDefault();
    });
  }

  // Keep the data: the struck-out line follows the checkbox.
  document.getElementById("keep-data")?.addEventListener("change", (event) => {
    location.href = go("uninstall", event.target.checked ? { keep: "1" } : {});
  });

  // Radio rows: choosing one enables what waits for it.
  root.querySelectorAll("[data-radio]").forEach((row, _i, rows) =>
    row.addEventListener("click", () => rows.forEach((other) => other.setAttribute("aria-checked", String(other === row)))),
  );

  // The first screen's choice list: Up and Down move, Home and End go to the ends.
  root.querySelector("[data-choice-list]")?.addEventListener("keydown", (event) => {
    const rows = [...root.querySelectorAll("[data-choice]")];
    const at = rows.indexOf(document.activeElement);
    if (at < 0) return;
    const to = { ArrowDown: Math.min(at + 1, rows.length - 1), ArrowUp: Math.max(at - 1, 0), Home: 0, End: rows.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    rows[to].focus();
  });

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
      if (status) status.textContent = `Selected. Press ${/Mac|iPhone|iPad/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy.`;
    }
  });

  // Escape is Back on a step screen, and Close in a page dialog.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || document.querySelector("[data-host-scrim]")) return;
    const target = root.querySelector(".b-close") || root.querySelector("[data-back]");
    if (target?.href) location.href = target.href;
  });

  // The prototype bar: every state, one choice away.
  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    extra.innerHTML =
      `<label class="proto-seg">State <select id="setup-state" aria-label="Setup state">` +
      Object.keys(known).map((key) => `<option value="${key}"${key === id ? " selected" : ""}>${key}</option>`).join("") +
      `</select></label>`;
    document.getElementById("setup-state").addEventListener("change", (event) => (location.href = go(event.target.value)));
  });

  CT.setupScreens = Object.keys(known);
  CT.setupHostDialogs = Object.keys(HOST);
})();
