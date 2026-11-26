// docs/design/connectors.md: tool servers (slice 1) and apps (slice 2), on a
// stand-in gateway. None of this is product code.
//
// One inventory lives in this page's memory. A write changes it only after the
// stand-in's read-back confirms the change, so every list and page shows the
// same confirmed state; an unconfirmed write leaves it as it was. The address
// picks the starting state only. No draft, key, program or argument is ever
// put in the address, and nothing is kept in storage: a reload starts again
// from the address.

(function () {
  const { CT } = window;
  const P = CT.params;
  const root = document.documentElement;

  // Dark is the default; light is offered.
  let storedTheme = null;
  try {
    storedTheme = localStorage.getItem("ct-proto-theme");
  } catch {
    storedTheme = null;
  }
  if (!P.get("theme") && !storedTheme) {
    CT.settings.theme = "dark";
    root.dataset.theme = "dark";
  }

  const pick = (key, allowed, fallback) => (allowed.includes(P.get(key)) ? P.get(key) : fallback);
  const V11 = "2026.11.10";
  const V10 = "2026.10.6";
  const version = P.get("gw") === "1006" ? V10 : V11;
  const delay = Number(P.get("delay") ?? 250);

  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const list = (names) =>
    names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

  // ---------- The stand-in gateway's inventory ----------

  const BOTS = [
    { id: "pip", name: "Pip", task: "Saturday errands route" },
    { id: "otto", name: "Otto", task: "Disk almost full on the media box" },
    { id: "juniper", name: "Juniper", task: "Library e-book apps compared", allowOnly: true },
    { id: "marlow", name: "Marlow", task: "Cover letter" },
  ];
  const botName = (id) => BOTS.find((b) => b.id === id)?.name ?? id;

  const NOTES_TOOLS = [
    ["search_notes", "Search notes by words or tags."],
    ["read_note", "Read one note."],
    ["create_note", "Create a note in a notebook."],
    ["append_to_note", "Add text to the end of a note."],
    ["list_notebooks", "List notebooks."],
    ["tag_note", "Add or remove a tag."],
    ["move_note", "Move a note to another notebook."],
    ["delete_note", "Delete a note."],
  ];

  const inv = {
    servers: {
      notes: {
        kind: "url",
        url: "https://notes.example/mcp",
        headers: ["Authorization"],
        oauth: false,
        reach: { kind: "tools", bot: "pip", time: "5:12 PM", tools: NOTES_TOOLS },
      },
      "local-search": {
        kind: "command",
        command: "/opt/example/bin/search-server",
        args: ["--stdio", "--index ./notes"],
        cwd: "/srv/notes",
        reach: { kind: "notyet" },
      },
      "team-docs": {
        kind: "url",
        url: "https://docs.example/mcp",
        headers: [],
        oauth: true,
        reach: { kind: version === V11 ? "signin" : "refused401", bot: "pip", time: "4:58 PM" },
      },
      wiki: {
        kind: "url",
        url: "https://wiki.example/mcp",
        headers: [],
        oauth: false,
        reach: {
          kind: "unreachable",
          bot: "otto",
          time: "4:40 PM",
          detail: 'MCP server "wiki": fetch failed | connect ECONNREFUSED; server unavailable; retry after 4:50 PM.',
        },
      },
      t3code: { kind: "managed", url: "https://code.example/mcp", headers: [], oauth: true, reach: { kind: "managed" } },
    },
    // Bots each server is denied to (`agents.entries.<id>.tools.deny` has `<server>__*`).
    denied: {
      notes: ["marlow"],
      "local-search": ["pip", "juniper", "marlow"],
      "team-docs": ["otto", "juniper", "marlow"],
      wiki: [],
      t3code: ["pip", "juniper", "marlow"],
    },
    signedIn: { "team-docs": P.get("signedin") !== "0" ? false : false },
    apps: {
      quillnote: {
        name: "Quillnote",
        author: "Quillnote Labs",
        official: true,
        summary: "Notes and notebooks your bots can search and write.",
        pkg: "@quillnote-labs/quillnote",
        versionText: "2.4.1",
        installed: false,
        featured: true,
        category: "productivity",
      },
      tasktide: {
        name: "Tasktide",
        author: "Tasktide",
        official: false,
        summary: "Tasks, reminders and due dates.",
        pkg: "tasktide-openclaw",
        versionText: null,
        installed: false,
        featured: true,
        category: "productivity",
      },
      ledgerkin: {
        name: "Ledgerkin",
        author: "Ledgerkin",
        official: false,
        summary: "Read your budgets and spending.",
        installed: true,
        state: "enabled",
        category: "finance",
      },
      calendrop: {
        name: "Calendrop",
        author: "Calendrop",
        official: true,
        summary: "Calendars and invitations.",
        installed: true,
        state: "enabled",
        category: "productivity",
        accounts: [
          { server: "calendrop-mail", state: "authorized" },
          { server: "calendrop-cal", state: "unauthenticated" },
        ],
      },
      mapwhistle: {
        name: "Mapwhistle",
        author: "Mapwhistle",
        official: false,
        summary: "Places, routes and travel times.",
        installed: false,
        unavailable: true,
        category: "travel",
      },
    },
  };
  // Start states from the address.
  if (P.get("state") === "empty") {
    inv.servers = {};
    inv.denied = {};
  }
  if (P.get("reach") && inv.servers.notes) {
    const kind = pick("reach", ["tools", "notyet", "unreachable", "refused401", "signin", "readfail", "withheld"], "tools");
    if (kind !== "withheld") inv.servers.notes.reach = { kind, bot: "pip", time: "5:12 PM", tools: NOTES_TOOLS, detail: "fetch failed | connect ECONNREFUSED" };
  }

  // ---------- Page state ----------

  const ui = {
    view: pick("view", ["settings", "apps"], "settings"),
    section: pick("section", ["servers", "integrations"], "servers"),
    screen: pick("screen", ["list", "add", "server", "browse", "app", "gateway"], "list"),
    name: P.get("name") || "notes",
    app: P.get("app") || "quillnote",
    loading: P.get("state") === "loading",
    loadfail: P.get("state") === "loadfail",
    access: pick("access", ["read", "admin"], "admin"),
    request: null,
    readonlyGw: P.get("readonlygw") === "1",
    from: BOTS.some((b) => b.id === P.get("from")) ? P.get("from") : null,
    pane: "section",
    // The outcome of the next write, and of the read after it, from the prototype bar.
    nextWrite: pick("write", ["accepted", "refused", "noanswer", "stale", "differs"], "accepted"),
    nextRead: pick("read", ["matches", "absent", "fails"], "matches"),
    botWrite: pick("botwrite", ["accepted", "refused"], "accepted"),
    pageAddr: pick("pageaddr", ["loopback", "https", "none"], "loopback"),
    hostSecret: P.get("hostsecret") !== "0",
    codeOutcome: pick("code", ["ok", "expired", "unknown"], "ok"),
    signinSaves: P.get("signinsaves") !== "0",
    catalog: pick("catalog", ["loaded", "offline", "loading", "refused"], "loaded"),
    form: null,
    busy: null, // a write in flight: its message
    result: null, // the last outcome on the current screen
    layer: null, // an open question or prompt
    signin: null, // the sign-in panel's state, for the open server
    task: null, // a "Try it" task: {bot, server, text, sent}
    botStatus: {}, // per bot on the open server page: "saving" | refusal text
    search: "",
    chip: "all",
    undo: null,
    returnFocus: null,
  };
  if (ui.screen === "add") ui.form = newForm(pick("kind", ["url", "command"], "url"));
  if (ui.view === "apps" && ui.screen === "list") ui.screen = "browse";

  function newForm(kind) {
    const chosen = ui.from ? [ui.from] : BOTS.map((b) => b.id);
    return {
      kind,
      url: "",
      name: "",
      nameEdited: false,
      oauth: false,
      key: "",
      more: false,
      headers: [],
      command: "",
      args: "",
      cwd: "",
      bots: chosen,
      errors: {},
    };
  }

  const canWrite = () => ui.access === "admin" && !ui.readonlyGw;
  const liveRegion = () => document.getElementById("c-live");
  const say = (text) => {
    const live = liveRegion();
    if (!live) return;
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };
  const wait = (ms = delay) => new Promise((r) => setTimeout(r, ms));
  const serverBots = (name) => BOTS.filter((b) => !(inv.denied[name] ?? []).includes(b.id)).map((b) => b.id);

  // ---------- The stand-in's writes ----------

  /** One `config.patch`, then a fresh `config.get`. Returns the ending the screen shows. */
  async function write(apply, describe) {
    const outcome = ui.nextWrite;
    const read = ui.nextRead;
    ui.nextWrite = "accepted";
    ui.nextRead = "matches";
    ui.busy = "Checking what the gateway has…";
    render();
    say("Checking what the gateway has");
    await wait();
    ui.busy = null;
    if (outcome === "refused") return { kind: "refused" };
    if (outcome === "stale") return { kind: "stale" };
    if (outcome === "differs") {
      apply({ differs: true });
      return { kind: "differs" };
    }
    if (outcome === "noanswer") {
      if (read === "fails") return { kind: "readfail", retry: { apply, describe } };
      if (read === "absent") return { kind: "absent" };
      apply({});
      return { kind: "matchedNoAnswer" };
    }
    if (read === "fails") return { kind: "readfail", retry: { apply, describe } };
    apply({});
    return { kind: "ok" };
  }

  // ---------- Rendering ----------

  function render() {
    const app = document.getElementById("c-root");
    const active = document.activeElement?.id;
    app.innerHTML = `<div class="c-backdrop-rail" aria-hidden="true"></div><div class="c-backdrop-main" aria-hidden="true"></div>
      <div class="c-scrim">${ui.view === "apps" ? appsWindow() : settingsWindow()}</div>${ui.layer ? layer() : ""}`;
    narrow();
    if (active && document.getElementById(active) && !ui.layer) document.getElementById(active).focus();
    if (ui.layer) {
      const first = document.querySelector(".c-dialog [data-autofocus]") ?? document.querySelector(".c-dialog button");
      first?.focus();
    }
  }

  function narrow() {
    const frame = document.querySelector(".proto-frame");
    const app = document.getElementById("c-root");
    if (frame && app) app.classList.toggle("c-narrow", frame.clientWidth < 688);
  }

  function windowShell(title, nav, body) {
    return `<div class="c-window" role="dialog" aria-modal="true" aria-labelledby="c-title">
      <div class="c-head"><h1 id="c-title">${esc(title)}</h1><button type="button" class="c-btn c-btn--quiet" data-act="noop" aria-label="Close">Close</button></div>
      <div class="c-frame" data-pane="${ui.pane}">
        <nav class="c-nav" aria-label="${esc(title)} sections"><ul>${nav}</ul></nav>
        <section class="c-section" aria-labelledby="c-section-title">
          ${ui.screen === "list" || ui.screen === "browse" || ui.screen === "gateway" ? `<button type="button" class="c-btn c-btn--quiet c-pane-back" data-act="pane-nav">Back to ${esc(title)}</button>` : ""}
          ${body}
        </section>
      </div></div>`;
  }

  function settingsWindow() {
    const navItem = (id, label, enabled) =>
      `<li><button type="button" ${enabled ? `data-act="nav" data-id="${id}"` : "disabled"} ${ui.section === id ? 'aria-current="page"' : ""}>${label}</button></li>`;
    const nav = navItem("gateway", "Gateway", false) + navItem("accounts", "Accounts", false) + navItem("integrations", "Integrations", true) + navItem("servers", "Tool servers", true);
    let body;
    if (ui.section === "integrations") body = `<h2 id="c-section-title" tabindex="-1">Integrations</h2><p class="c-lede">T3 Code is designed in bots.md, sections 15 to 18.</p>`;
    else if (ui.screen === "add") body = addScreen();
    else if (ui.screen === "server") body = serverScreen();
    else body = listScreen();
    return windowShell("Settings", nav, body);
  }

  function readonlyNote(what = "Tool servers") {
    return ui.readonlyGw
      ? `<div class="c-note" role="note"><p><strong>This gateway's settings are read-only.</strong> ${what} can't be changed here.</p></div>`
      : "";
  }

  function accessBar(words) {
    if (ui.readonlyGw || ui.access === "admin") return "";
    const r = ui.request;
    const text =
      r === "asking"
        ? "Asking the gateway…"
        : r === "requested"
          ? "<strong>Waiting for the gateway's owner.</strong> Approve this request where the gateway's owner approves devices. Request 3f9a2c71"
          : `<strong>Read-only.</strong> ${esc(words)}`;
    const action =
      r === "asking" ? "" : r === "requested" ? `<button type="button" class="c-btn" data-act="access-check">Check now</button>` : `<button type="button" class="c-btn c-btn--primary" data-act="access-request">Request admin access</button>`;
    return `<div class="c-access" role="status"><p>${text}</p>${action}</div>`;
  }

  // ----- Settings, Tool servers -----

  function stateWord(name) {
    const s = inv.servers[name];
    const r = s.reach;
    if (s.kind === "managed") return ["Managed in Integrations", ""];
    if (r.kind === "tools") return [plural(r.tools.length, "tool", "tools"), ""];
    if (r.kind === "notyet" || r.kind === "readfail") return ["Not reached yet", ""];
    if (r.kind === "signin") return ["Needs sign-in", "warn"];
    if (r.kind === "refused401") return ["Needs a key or sign-in", "warn"];
    if (r.kind === "unreachable" || r.kind === "nostart") return ["Can't reach it", "danger"];
    return ["Not reached yet", ""];
  }

  function serverSub(name) {
    const s = inv.servers[name];
    return s.kind === "command" ? "Runs a program on the gateway's machine" : s.url;
  }

  function listScreen() {
    const title = `<h2 id="c-section-title" tabindex="-1">Tool servers</h2>`;
    if (ui.loading) return `${title}<ul class="c-rows" aria-busy="true" aria-label="Loading tool servers"><li class="c-grey"></li><li class="c-grey"></li><li class="c-grey"></li></ul>`;
    if (ui.loadfail)
      return `${title}<div class="c-note c-note--danger" role="alert"><p><strong>Couldn't load the gateway's settings.</strong> The gateway did not answer.</p><div class="c-actions"><button type="button" class="c-btn" data-act="reload">Try again</button></div></div>`;
    const names = Object.keys(inv.servers).sort();
    const add = canWrite() ? `<div class="c-actions"><button type="button" class="c-btn c-btn--primary" id="c-add" data-act="add">Add a tool server</button></div>` : "";
    const undo = ui.undo
      ? `<div class="c-result" role="status"><p><strong>Removed ${esc(ui.undo.name)}.</strong> The gateway's settings no longer have it.</p><div class="c-actions"><button type="button" class="c-btn" id="c-undo" data-act="undo">Undo</button></div></div>`
      : "";
    const result = ui.result?.where === "list" ? resultBlock(ui.result) : "";
    if (names.length === 0)
      return `${title}${readonlyNote()}${undo}${result}<div class="c-note"><p><strong>No tool servers yet.</strong> A tool server gives your bots tools from another app or service. Add one by its address, or as a program on the gateway's machine.</p></div>${add}${accessBar("Changing tool servers needs admin access.")}`;
    const rows = names
      .map((name) => {
        const [word, tone] = stateWord(name);
        const bots = serverBots(name).map(botName);
        const botsText = inv.servers[name].kind === "managed" ? "" : bots.length ? list(bots) : "No bots";
        return `<li><button type="button" class="c-row" data-act="open" data-name="${esc(name)}" id="c-row-${esc(name)}" aria-label="${esc(`${name}, ${word}${botsText ? `, ${botsText}` : ""}`)}">
          <span class="c-initial" aria-hidden="true">${esc(name[0].toUpperCase())}</span>
          <span class="c-row-main"><span class="c-row-name c-mono">${esc(name)}</span><span class="c-row-sub">${esc(serverSub(name))}</span></span>
          <span class="c-row-end"><span class="c-pill${tone ? ` c-pill--${tone}` : ""}">${esc(word)}</span><span class="c-faint">${esc(botsText)}</span></span>
        </button></li>`;
      })
      .join("");
    return `${title}${readonlyNote()}${undo}${result}<p class="c-lede">Tools your bots get from other apps and services. Each server is on the gateway, for the bots ticked on its page.</p><ul class="c-rows" aria-label="Tool servers">${rows}</ul>${add}${accessBar("Changing tool servers needs admin access.")}`;
  }

  // ----- Adding -----

  function addScreen() {
    const f = ui.form;
    const back = `<button type="button" class="c-btn c-btn--quiet c-back" data-act="back">Back to Tool servers</button>`;
    const title = `<h2 id="c-section-title" tabindex="-1">Add a tool server</h2>`;
    if (ui.result?.where === "add") return `${back}${title}${resultBlock(ui.result)}`;
    if (!canWrite()) return `${back}${title}${readonlyNote()}${accessBar("Adding a tool server needs admin access.")}${ui.readonlyGw ? "" : formFields(f, true)}`;
    return `${back}${title}${formFields(f, false)}`;
  }

  function fieldError(f, key) {
    return f.errors[key] ? `<span class="c-error" id="c-err-${key}">${esc(f.errors[key])}</span>` : "";
  }
  function invalid(f, key) {
    return f.errors[key] ? ` aria-invalid="true" aria-describedby="c-err-${key}"` : "";
  }

  function formFields(f, disabled) {
    const dis = disabled ? " disabled" : "";
    const kind = `<fieldset class="c-radios" role="radiogroup" aria-label="Kind">
      <label><input type="radio" name="c-kind" value="url" id="c-kind-url"${f.kind === "url" ? " checked" : ""}${dis}> By address</label>
      <label><input type="radio" name="c-kind" value="command" id="c-kind-command"${f.kind === "command" ? " checked" : ""}${dis}> Runs a program on the gateway's machine</label></fieldset>`;
    const name = `<div class="c-field"><label for="c-name">Name</label><input class="c-input c-mono" id="c-name" value="${esc(f.name)}" autocomplete="off"${invalid(f, "name")}${dis}>${fieldError(f, "name")}<span class="c-hint">The name bots see in tool names, like ${esc(f.name || "notes")}__search.</span></div>`;
    let fields;
    if (f.kind === "url") {
      const headers = f.more
        ? `<div class="c-field"><span class="c-legend">Headers</span>${f.headers
            .map(
              (h, i) =>
                `<span class="c-check"><input class="c-input c-mono" aria-label="Header ${i + 1} name" data-header="${i}" data-part="name" value="${esc(h.name)}"${dis}><input class="c-input" type="password" aria-label="Header ${i + 1} value" data-header="${i}" data-part="value" value="${esc(h.value)}"${dis}></span>`,
            )
            .join("")}<button type="button" class="c-btn c-btn--quiet" data-act="add-header"${dis}>Add a header</button></div>`
        : `<button type="button" class="c-btn c-btn--quiet" data-act="more" id="c-more"${dis}>More</button>`;
      fields = `<div class="c-field"><label for="c-url">Address</label><input class="c-input" id="c-url" inputmode="url" placeholder="https://" value="${esc(f.url)}" autocomplete="off"${invalid(f, "url")}${dis}>${fieldError(f, "url")}</div>
        ${name}
        <div class="c-field"><label class="c-check"><input type="checkbox" id="c-oauth"${f.oauth ? " checked" : ""}${dis}> Sign in with an account (OAuth)</label></div>
        <div class="c-field"><label for="c-key">Key</label><input class="c-input" id="c-key" type="password" autocomplete="off" value="${esc(f.key)}"${dis}><span class="c-hint">The gateway keeps the key in its settings file, unencrypted. Clawtrate can't show it again.</span></div>
        ${headers}`;
    } else {
      fields = `<div class="c-field"><label for="c-command">Program</label><input class="c-input c-mono" id="c-command" placeholder="/opt/example/bin/server" value="${esc(f.command)}" autocomplete="off"${invalid(f, "command")}${dis}>${fieldError(f, "command")}</div>
        <div class="c-field"><label for="c-args">Arguments</label><textarea class="c-input" id="c-args" aria-describedby="c-args-hint"${dis}>${esc(f.args)}</textarea><span class="c-hint" id="c-args-hint">One per line. Spaces inside a line stay part of it. Nothing goes through a shell.</span></div>
        <div class="c-field"><label for="c-cwd">Folder</label><input class="c-input c-mono" id="c-cwd" value="${esc(f.cwd)}" autocomplete="off"${dis}></div>
        ${name}`;
    }
    const bots = botChoice(f.bots, { form: true, disabled, server: f.name || "this server", program: f.kind === "command" ? f.command : null });
    const runs = f.kind === "command" ? `<div class="c-note" id="c-runs" aria-live="polite">${runsLine(reviewed(f))}</div>` : "";
    const busy = ui.busy ? `<p class="c-faint" role="status">${esc(ui.busy)}</p>` : "";
    const add = disabled ? "" : `<div class="c-actions"><button type="button" class="c-btn c-btn--primary" id="c-submit" data-act="submit"${ui.busy ? " disabled" : ""}>Add</button></div>`;
    return `<form class="c-form" novalidate onsubmit="return false">${kind}${fields}${bots}${runs}${busy}${add}</form>`;
  }

  /** What a program server does, from the reviewed values: shown on the form and in the result. */
  function runsLine(r) {
    if (!r.command) return "";
    const args = r.args.length ? `<ul class="c-arglist" aria-label="Arguments">${r.args.map((a) => `<li class="c-mono">${esc(a)}</li>`).join("")}</ul>` : `<p>No arguments</p>`;
    return `<p>Adds a server that the gateway starts on studio's machine when a bot needs it, as the user the gateway runs as:</p><p class="c-mono c-runs-program">${esc(r.command)}</p>${args}${r.cwd ? `<p>In <span class="c-mono c-runs-cwd">${esc(r.cwd)}</span></p>` : ""}<p class="c-faint">It can read and change what that user can, and reach the network. The gateway's settings show the program and its arguments to anyone who can read them, so don't put a key in them.</p>`;
  }

  function botChoice(chosen, { form, disabled, server, program, status = {} }) {
    const items = BOTS.map((b) => {
      const st = status[b.id];
      const withheld = !form && chosen.includes(b.id) && b.allowOnly && inv.servers[server]?.kind !== "managed";
      const line =
        st === "saving"
          ? `<span class="c-bot-status" role="status">Saving…</span>`
          : st
            ? `<span class="c-bot-status c-bot-status--warn" role="alert">${esc(st)}</span>`
            : withheld
              ? `<span class="c-bot-status c-bot-status--warn">${esc(b.name)}'s tool rules don't offer ${esc(server)}'s tools. <button type="button" class="c-btn c-btn--quiet" data-act="noop">Open ${esc(b.name)}'s rules</button></span>`
              : "";
      return `<li class="c-bot"><label class="c-check"><input type="checkbox" data-bot="${b.id}" id="c-bot-${b.id}"${chosen.includes(b.id) ? " checked" : ""}${disabled || st === "saving" ? " disabled" : ""}><span class="c-avatar" aria-hidden="true">${esc(b.name[0])}</span>${esc(b.name)}</label>${line}</li>`;
    }).join("");
    const under = program
      ? `Each bot ticked can have the gateway start ${program}.`
      : `Each bot ticked can use every tool ${server} offers. What each may do with them is in its settings.`;
    return `<fieldset class="c-bots"><legend class="${form ? "c-legend" : "visually-hidden"}">Bots</legend><ul>${items}</ul><p class="c-hint">${esc(under)}</p></fieldset>`;
  }

  function readValues() {
    const f = ui.form;
    const v = (id) => document.getElementById(id)?.value ?? "";
    if (f.kind === "url") {
      f.url = v("c-url");
      f.key = v("c-key");
      f.oauth = document.getElementById("c-oauth")?.checked ?? f.oauth;
    } else {
      f.command = v("c-command");
      f.args = v("c-args");
      f.cwd = v("c-cwd");
    }
    f.name = v("c-name");
    document.querySelectorAll("[data-header]").forEach((input) => {
      f.headers[Number(input.dataset.header)][input.dataset.part] = input.value;
    });
    f.bots = [...document.querySelectorAll(".c-bots input[data-bot]")].filter((i) => i.checked).map((i) => i.dataset.bot);
  }

  /** The form's values as the write will send them: trimmed, arguments one per line. */
  function reviewed(f) {
    if (f.kind === "url") return { kind: "url", name: f.name.trim(), url: f.url.trim(), oauth: f.oauth, headers: [...(f.key ? ["Authorization"] : []), ...f.headers.filter((h) => h.name.trim()).map((h) => h.name.trim())], bots: [...f.bots] };
    return {
      kind: "command",
      name: f.name.trim(),
      command: f.command.trim(),
      args: f.args.split("\n").map((a) => a.trim()).filter(Boolean),
      cwd: f.cwd.trim(),
      bots: [...f.bots],
    };
  }

  function validate(f, r) {
    const errors = {};
    if (r.kind === "url") {
      let parsed = null;
      try {
        parsed = new URL(r.url);
      } catch {
        parsed = null;
      }
      if (!r.url) errors.url = "Enter the server's address.";
      else if (!parsed || parsed.protocol !== "https:") errors.url = "That isn't a server address. It starts with https://.";
    } else if (!r.command) errors.command = "Enter the program to run.";
    if (!r.name) errors.name = "Enter a name.";
    else if (!/^[A-Za-z0-9_-]+$/.test(r.name)) errors.name = "Use letters, digits, - and _ only.";
    else if (inv.servers[r.name]) errors.name = `There's already a server named ${r.name}. Choose another name.`;
    f.errors = errors;
    return Object.keys(errors).length === 0;
  }

  function nameFromUrl(url) {
    try {
      const host = new URL(url.trim()).hostname;
      return (host.split(".")[0] || "").toLowerCase().replace(/[^a-z0-9_-]/g, "");
    } catch {
      return "";
    }
  }

  async function submit() {
    readValues();
    const f = ui.form;
    const r = reviewed(f);
    if (!validate(f, r)) {
      render();
      const first = ["url", "command", "name"].find((k) => f.errors[k]);
      document.getElementById(`c-${first}`)?.focus();
      return;
    }
    await commitAdd(r);
  }

  async function commitAdd(r) {
    const ending = await write((how) => {
      inv.servers[r.name] =
        r.kind === "url"
          ? { kind: "url", url: how.differs ? r.url.replace(/\/mcp$/, "/v2/mcp") : r.url, headers: r.headers, oauth: r.oauth, reach: { kind: "notyet" } }
          : { kind: "command", command: r.command, args: how.differs ? [...r.args, "--read-only"] : r.args, cwd: r.cwd, reach: { kind: "notyet" } };
      inv.denied[r.name] = BOTS.map((b) => b.id).filter((id) => !r.bots.includes(id));
    });
    ui.result = { where: "add", ending, reviewed: r };
    render();
    say(ending.kind === "ok" || ending.kind === "matchedNoAnswer" ? `Added ${r.name}` : `Couldn't add ${r.name}`);
    document.querySelector(".c-result [data-first]")?.focus();
  }

  function resultBlock(res) {
    const r = res.reviewed;
    const name = r?.name ?? ui.name;
    const e = res.ending;
    if (res.kind === "removed") return "";
    if (e.kind === "ok" || e.kind === "matchedNoAnswer") {
      const bots = r.bots.map(botName);
      const who = bots.length === 0 ? "No bot can use it yet." : `${list(bots)} can use it.`;
      const lead = e.kind === "ok" ? `<strong>Added ${esc(name)}.</strong> ${esc(who)}` : `The gateway has ${esc(name)} with these settings. ${esc(who)}`;
      const key = r.headers?.length ? `<p class="c-faint">The gateway hides the key; Clawtrate can't show it again.</p>` : "";
      const runs = r.kind === "command" ? runsLine(r) : "";
      const undo = `<button type="button" class="c-btn c-btn--quiet" data-act="undo-add" data-name="${esc(name)}" id="c-undo-add">Undo</button>`;
      const first = r.bots[0];
      const actions = r.oauth
        ? `<button type="button" class="c-btn c-btn--primary" data-first data-act="signin" data-name="${esc(name)}">Sign in</button><button type="button" class="c-btn" data-act="open" data-name="${esc(name)}">Open ${esc(name)}</button>`
        : `${first ? `<button type="button" class="c-btn c-btn--primary" data-first data-act="try" data-name="${esc(name)}" data-bot="${first}">Try it with ${esc(botName(first))}</button>` : ""}<button type="button" class="c-btn"${first ? "" : " data-first"} data-act="open" data-name="${esc(name)}">Open ${esc(name)}</button>`;
      return `<div class="c-result" role="status"><p>${lead}</p>${key}${runs}<div class="c-actions">${actions}${undo}</div></div>`;
    }
    if (e.kind === "differs") {
      const s = inv.servers[name];
      return `<div class="c-result c-note--warn" role="alert"><p><strong>Couldn't confirm the change.</strong> The gateway has a different entry for ${esc(name)}.</p><dl class="c-facts">${s?.kind === "command" ? `<dt>Program</dt><dd class="c-mono">${esc(s.command)}</dd><dt>Arguments</dt><dd>${s.args.length ? `<ul class="c-arglist">${s.args.map((x) => `<li class="c-mono">${esc(x)}</li>`).join("")}</ul>` : "No arguments"}</dd>` : `<dt>Address</dt><dd class="c-mono">${esc(s?.url ?? "")}</dd>`}</dl><div class="c-actions"><button type="button" class="c-btn" data-first data-act="open" data-name="${esc(name)}">Open ${esc(name)}</button></div></div>`;
    }
    if (e.kind === "readfail")
      return `<div class="c-result c-note--warn" role="alert"><p><strong>Couldn't confirm the change.</strong> The gateway's settings couldn't be read.</p><div class="c-actions"><button type="button" class="c-btn" data-first data-act="check-again">Check again</button></div></div>`;
    if (e.kind === "absent")
      return `<div class="c-result" role="status"><p>The gateway's settings have no server named ${esc(name)}. Nothing was added.</p><div class="c-actions"><button type="button" class="c-btn" data-first data-act="edit-again">Back to the form</button></div></div>`;
    if (e.kind === "stale")
      return `<div class="c-result c-note--warn" role="alert"><p><strong>The gateway's settings changed</strong> while you were here. Check the server below and try again.</p><div class="c-actions"><button type="button" class="c-btn" data-first data-act="edit-again">Back to the form</button></div></div>`;
    if (e.kind === "refused")
      return `<div class="c-result c-note--danger" role="alert"><p><strong>Couldn't add ${esc(name)}:</strong> the gateway is busy with another change. Try again in a moment.</p><div class="c-actions"><button type="button" class="c-btn" data-first data-act="edit-again">Back to the form</button></div></div>`;
    return "";
  }

  async function checkAgain() {
    const res = ui.result;
    const read = ui.nextRead;
    ui.nextRead = "matches";
    ui.busy = "Checking what the gateway has…";
    render();
    await wait();
    ui.busy = null;
    if (read === "fails") ui.result = { ...res, ending: { kind: "readfail", retry: res.ending.retry } };
    else if (read === "absent") ui.result = { ...res, ending: { kind: "absent" } };
    else {
      res.ending.retry.apply({});
      ui.result = { ...res, ending: { kind: "matchedNoAnswer" } };
    }
    render();
    document.querySelector(".c-result [data-first]")?.focus();
  }

  // ----- A server's page -----

  function reachBlock(name) {
    const s = inv.servers[name];
    const r = s.reach;
    const bots = serverBots(name);
    const firstBot = bots[0];
    const tryBtn = firstBot && canWrite() ? `<button type="button" class="c-btn" data-act="try" data-name="${esc(name)}" data-bot="${firstBot}">Try it with ${esc(botName(firstBot))}</button>` : "";
    const task = (id) => BOTS.find((b) => b.id === id)?.task ?? "its latest task";
    let body;
    if (bots.length === 0) body = `<p>No bot can use ${esc(name)}.</p>`;
    else if (r.kind === "tools")
      body = `<p><strong>Reached in ${esc(botName(r.bot))}'s task</strong> at ${esc(r.time)}: ${plural(r.tools.length, "tool", "tools")}</p><p class="c-faint">“${esc(task(r.bot))}”</p><details class="c-fold"><summary>The tools</summary><ul class="c-tools">${r.tools.map(([t, d]) => `<li><span class="c-mono">${esc(t)}</span>: ${esc(d)}</li>`).join("")}</ul></details>`;
    else if (r.kind === "notyet") body = `<p><strong>Not reached yet.</strong> The gateway connects to ${esc(name)} the next time ${esc(botName(firstBot))} runs.</p>`;
    else if (r.kind === "unreachable")
      body = `<p><strong>The gateway can't reach ${esc(name)}.</strong> Check that the server is running and that the gateway's machine can reach ${esc(hostOf(s.url))}.</p><details class="c-fold"><summary>Details</summary><p class="c-mono">${esc(r.detail ?? "")}</p></details>`;
    else if (r.kind === "nostart") body = `<p><strong>The gateway couldn't start the program.</strong> ${esc(s.command)} isn't on the gateway's machine.</p>`;
    else if (r.kind === "refused401")
      body = `<p><strong>${esc(name)} refused the gateway.</strong> It needs a key or an account sign-in.</p>${canWrite() ? `<div class="c-actions"><button type="button" class="c-btn" data-act="noop">Add a key</button>${s.oauth && !ui.signin ? `<button type="button" class="c-btn c-btn--primary" data-act="signin" data-name="${esc(name)}">Sign in</button>` : `<button type="button" class="c-btn" data-act="noop">Sign in with an account</button>`}</div>` : ""}`;
    else if (r.kind === "signin")
      body = `<p><strong>${esc(name)} needs you to sign in.</strong> The gateway hides its tools until it is signed in.</p>${canWrite() && !ui.signin ? `<div class="c-actions"><button type="button" class="c-btn c-btn--primary" data-act="signin" data-name="${esc(name)}">Sign in</button></div>` : ""}`;
    else if (r.kind === "readfail") body = `<p>Couldn't read ${esc(botName(firstBot))}'s tool listing.</p><div class="c-actions"><button type="button" class="c-btn" data-act="reach-again" data-name="${esc(name)}">Check again</button></div>`;
    return `<section class="c-note" aria-label="Reached">${body}<p class="c-faint">This is what the gateway listed for that task when it was read. A bot's own tool rules still decide which of these it may call.</p>${r.kind === "notyet" || r.kind === "tools" ? (tryBtn ? `<div class="c-actions">${tryBtn}</div>` : "") : ""}</section>`;
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  function serverScreen() {
    const name = ui.name;
    const s = inv.servers[name];
    const back = `<button type="button" class="c-btn c-btn--quiet c-back" data-act="back" id="c-back">Back to Tool servers</button>`;
    if (!s) return `${back}<h2 id="c-section-title" tabindex="-1">${esc(name)}</h2><p>The gateway's settings have no server named ${esc(name)}.</p>`;
    if (s.kind === "managed")
      return `${back}<div class="c-page-head"><span class="c-initial c-initial--lg" aria-hidden="true">T</span><h2 id="c-section-title" tabindex="-1" class="c-mono">${esc(name)}</h2></div><p>T3 Code's server. Its bots and sign-in are in Integrations.</p><div class="c-actions"><button type="button" class="c-btn" data-act="nav" data-id="integrations">Open Integrations</button></div>`;
    const facts =
      s.kind === "url"
        ? `<dt>Kind</dt><dd>By address</dd><dt>Address</dt><dd class="c-mono">${esc(s.url)}</dd><dt>Key</dt><dd>${s.headers.includes("Authorization") ? "Saved. The gateway hides it." : "None"}${s.headers.filter((h) => h !== "Authorization").map((h) => `<br><span class="c-mono">${esc(h)}</span>: hidden`).join("")}</dd><dt>Sign-in</dt><dd>${s.oauth ? "With an account (OAuth)" : "None"}</dd>`
        : `<dt>Kind</dt><dd>Runs a program on the gateway's machine</dd><dt>Program</dt><dd class="c-mono">${esc(s.command)}</dd><dt>Arguments</dt><dd>${s.args.length ? `<ul class="c-arglist">${s.args.map((a) => `<li class="c-mono">${esc(a)}</li>`).join("")}</ul>` : "No arguments"}</dd>${s.cwd ? `<dt>Folder</dt><dd class="c-mono">${esc(s.cwd)}</dd>` : ""}`;
    const result = ui.result?.where === "server" ? `<div class="c-result" role="status"><p>${ui.result.html}</p></div>` : "";
    const busy = ui.busy ? `<p class="c-faint" role="status">${esc(ui.busy)}</p>` : "";
    const signin = ui.signin ? signinPanel(name) : "";
    const actions = canWrite()
      ? `<div class="c-actions">${s.oauth && !ui.signin ? `<button type="button" class="c-btn" data-act="signin" data-name="${esc(name)}">Sign in</button>` : ""}${s.oauth && version === V11 ? `<button type="button" class="c-btn" data-act="signout" data-name="${esc(name)}" id="c-signout">Sign out</button>` : ""}<button type="button" class="c-btn c-btn--danger" id="c-remove" data-act="remove" data-name="${esc(name)}">Remove</button></div>${removeLine(s)}`
      : "";
    return `${back}<div class="c-page-head"><span class="c-initial c-initial--lg" aria-hidden="true">${esc(name[0].toUpperCase())}</span><h2 id="c-section-title" tabindex="-1" class="c-mono">${esc(name)}</h2></div>
      ${readonlyNote()}${result}${busy}<dl class="c-facts">${facts}</dl>${signin}${reachBlock(name)}
      <h3>Bots</h3>${botChoice(serverBots(name), { form: false, disabled: !canWrite(), server: name, program: s.kind === "command" ? s.command : null, status: ui.botStatus })}
      ${task()}${actions}${accessBar("Changing tool servers needs admin access.")}`;
  }

  function removeLine(s) {
    const goes = ["Its entry, with its key and headers", "Its tools, for every bot"];
    const stays = [];
    if (s.oauth && version === V11) goes.push("Its saved sign-in");
    if (s.oauth && version === V10) stays.push("Its saved sign-in, in the gateway's state, unencrypted. Adding a server with the same name and address finds it again.");
    if (!stays.length) stays.push("Nothing: Clawtrate also takes it out of each bot's rules.");
    return `<div class="c-goes" aria-label="What Remove does"><div><h4>Remove takes</h4><ul>${goes.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div><div><h4>It leaves</h4><ul>${stays.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div></div>`;
  }

  function task() {
    const t = ui.task;
    if (!t) return "";
    const head = `<p><strong>New task with ${esc(botName(t.bot))}</strong></p>`;
    if (t.sent === "running") return `<div class="c-task" role="status">${head}<p class="c-faint">${esc(botName(t.bot))} is working…</p></div>`;
    if (t.sent) return `<div class="c-task">${head}<p>You: ${esc(t.text)}</p><p>${esc(botName(t.bot))}: ${esc(t.reply)}</p></div>`;
    return `<div class="c-task">${head}<label for="c-message" class="visually-hidden">Message ${esc(botName(t.bot))}</label><textarea class="c-input" id="c-message">${esc(t.text)}</textarea><p class="c-faint">Nothing is sent until you send it. A message uses ${esc(botName(t.bot))}'s model.</p><div class="c-actions"><button type="button" class="c-btn c-btn--primary" data-act="send" id="c-send">Send</button></div></div>`;
  }

  // ----- Sign-in -----

  function signinPanel(name) {
    const st = ui.signin;
    if (st.stage === "noaddress")
      return `<div class="c-note c-note--warn" role="alert"><p><strong>Signing in needs the gateway's page in a browser.</strong> This gateway has no address a browser can sign in from. Give it an https or Tailscale address in its settings.</p></div>`;
    if (st.stage === "back") {
      const text = `<strong>The gateway's page signs in for every bot that can use ${esc(name)}.</strong> ${esc(botName(serverBots(name)[0] ?? "pip"))} gets its tools on its next message.`;
      const first = serverBots(name)[0];
      return `<div class="c-result" role="status"><p>${text}</p><div class="c-actions">${first ? `<button type="button" class="c-btn c-btn--primary" data-act="try" data-name="${esc(name)}" data-bot="${first}" id="c-try-after">Try it with ${esc(botName(first))}</button>` : ""}</div></div>`;
    }
    const page = ui.pageAddr === "https" ? "https://studio.example" : "http://127.0.0.1:18789";
    const steps = `<ol class="c-steps"><li>On the gateway's page, find ${esc(name)} and choose <strong>Sign in</strong>.</li><li>Approve access on the page ${esc(hostOf(inv.servers[name].url))} shows.</li><li>Come back here.</li></ol>`;
    let first;
    if (version === V11) {
      const err = st.codeError ? `<span class="c-error" id="c-err-code">${esc(st.codeError)}</span>` : "";
      first =
        st.approved
          ? `<p role="status">Browser approved. It connects by itself.</p>`
          : `<div class="c-field"><label for="c-code">If the gateway's page shows a code, enter it here.</label><input class="c-input c-mono" id="c-code" autocomplete="off" value="${esc(st.code ?? "")}" placeholder="ABCD-EFGH"${st.codeError ? ' aria-invalid="true" aria-describedby="c-err-code"' : ""}>${err}</div>`;
    } else {
      const copied = st.copied === "ok" ? `<p role="status">Copied. Paste it on the gateway's page. Clawtrate clears the clipboard in 60 seconds if it still holds it.</p>` : st.copied === "failed" ? `<p role="alert" class="c-error">Couldn't copy the gateway's secret.</p>` : "";
      first = ui.hostSecret
        ? `<p>If the gateway's page asks for its secret, paste it there.</p><div class="c-actions"><button type="button" class="c-btn" data-act="copy-secret" id="c-copy">Copy the gateway's secret</button></div>${copied}`
        : `<p>If the gateway's page asks for its secret, paste it there, from where you keep it.</p>`;
    }
    return `<section class="c-note" aria-label="Signing in to ${esc(name)}"><p><strong>The gateway's page is open in your browser.</strong> <span class="c-mono">${esc(page)}/settings/mcp</span></p>${steps}<h3>The browser's first visit</h3>${first}<div class="c-actions"><button type="button" class="c-btn" data-act="signin-open" data-name="${esc(name)}">Open the gateway's page again</button><button type="button" class="c-btn c-btn--primary" data-act="signin-back" data-name="${esc(name)}" id="c-back-here">I'm back</button></div></section>`;
  }

  // ----- Dialogs -----

  function layer() {
    const l = ui.layer;
    if (l.kind === "signout") {
      return `<div class="c-layer"><div class="c-dialog" role="alertdialog" aria-modal="true" aria-labelledby="c-q-title" aria-describedby="c-q-desc">
        <h2 id="c-q-title">Sign out of ${esc(l.name)}?</h2><p id="c-q-desc">Every bot that uses it loses its tools until someone signs in again on the gateway's page.</p>
        <div class="c-actions"><button type="button" class="c-btn" data-act="layer-cancel" data-autofocus>Cancel</button><button type="button" class="c-btn c-btn--danger" data-act="signout-confirm" data-name="${esc(l.name)}">Sign out</button></div></div></div>`;
    }
    if (l.kind === "remove") {
      const s = inv.servers[l.name];
      const lines = [`Its key goes with it, and Clawtrate can't put it back: the gateway never shows a saved key.`];
      if (s.oauth && version === V11) lines.push("Its sign-in goes too.");
      if (!s.headers.length) lines[0] = "Its sign-in goes with it, and signing in again takes the gateway's page.";
      return `<div class="c-layer"><div class="c-dialog" role="alertdialog" aria-modal="true" aria-labelledby="c-q-title" aria-describedby="c-q-desc">
        <h2 id="c-q-title">Remove ${esc(l.name)}?</h2><p id="c-q-desc">${esc(lines.join(" "))}</p>
        <div class="c-actions"><button type="button" class="c-btn" data-act="layer-cancel" data-autofocus>Cancel</button><button type="button" class="c-btn c-btn--danger" data-act="remove-confirm" data-name="${esc(l.name)}">Remove ${esc(l.name)}</button></div></div></div>`;
    }
    if (l.kind === "pair") {
      return `<div class="c-layer"><div class="c-dialog" role="alertdialog" aria-modal="true" aria-labelledby="c-q-title" aria-describedby="c-q-desc">
        <h2 id="c-q-title">Let this browser control studio?</h2>
        <dl class="c-facts"><dt>Browser</dt><dd>Safari 26.2 on macOS (reported)</dd><dt>Page</dt><dd class="c-mono">/settings/mcp (reported)</dd><dt>Seen by the gateway</dt><dd>From 127.0.0.1</dd><dt>Code</dt><dd class="c-mono">${esc(l.code)}</dd></dl>
        <p id="c-q-desc">Gets full control of the gateway, as this app has. Approve it only if this is the code on the page you just opened.</p>
        <div class="c-actions"><button type="button" class="c-btn" data-act="pair-reject" data-autofocus>Not this one</button><button type="button" class="c-btn c-btn--primary" data-act="pair-approve">Approve</button></div></div></div>`;
    }
    if (l.kind === "app-add") {
      const a = inv.apps[l.id];
      return `<div class="c-layer"><div class="c-dialog" role="alertdialog" aria-modal="true" aria-labelledby="c-q-title" aria-describedby="c-q-desc">
        <h2 id="c-q-title">Add ${esc(a.name)} to studio?</h2>
        <p>Package <span class="c-mono">${esc(a.pkg)}</span> from ClawHub, ${a.versionText ? `version ${esc(a.versionText)}.` : "The gateway picks the release."}</p>
        <p id="c-q-desc">The gateway installs this package on its machine and runs it with the gateway's access. Every bot that isn't left out can use its tools.</p>
        <div class="c-actions"><button type="button" class="c-btn" data-act="layer-cancel" data-autofocus>Cancel</button><button type="button" class="c-btn c-btn--primary" data-act="app-add-confirm" data-id="${esc(l.id)}">Add</button></div></div></div>`;
    }
    if (l.kind === "app-remove") {
      const a = inv.apps[l.id];
      return `<div class="c-layer"><div class="c-dialog" role="alertdialog" aria-modal="true" aria-labelledby="c-q-title" aria-describedby="c-q-desc">
        <h2 id="c-q-title">Remove ${esc(a.name)} from studio?</h2>
        <p id="c-q-desc">Its settings on the gateway go with it, and adding it again starts from the beginning.${version === V11 ? " Its saved sign-ins go too." : " Any saved sign-ins stay in the gateway's state, unencrypted."}</p>
        <div class="c-actions"><button type="button" class="c-btn" data-act="layer-cancel" data-autofocus>Cancel</button><button type="button" class="c-btn c-btn--danger" data-act="app-remove-confirm" data-id="${esc(l.id)}">Remove ${esc(a.name)}</button></div></div></div>`;
    }
    return "";
  }

  // ---------- Slice 2: Connect apps ----------

  function appsWindow() {
    const navItem = (id, label) =>
      `<li><button type="button" data-act="apps-nav" data-id="${id}" ${onGatewaySide() === (id === "gateway") ? 'aria-current="page"' : ""}>${label}</button></li>`;
    const nav = navItem("browse", "Browse") + navItem("gateway", "On this gateway");
    const body = ui.screen === "app" ? appScreen() : ui.screen === "gateway" ? onGateway() : browse();
    return windowShell("Connect apps", nav, body);
  }

  function onGatewaySide() {
    return ui.screen === "gateway" || (ui.screen === "app" && Boolean(inv.apps[ui.app]?.installed));
  }

  function appRow(id) {
    const a = inv.apps[id];
    let end;
    if (a.installed) end = `<span class="c-pill">${a.state === "disabled" ? "Turned off" : "Added"}</span>`;
    else if (a.unavailable) end = `<span class="c-faint">Not available</span>`;
    else if (ui.catalog === "offline") end = "";
    else end = canWrite() ? `<span class="c-pill">Add</span>` : "";
    const label = `${a.name}, ${a.installed ? (a.state === "disabled" ? "Turned off" : "Added") : a.unavailable ? "Not available" : "Add"}, ${a.summary}`;
    return `<li data-app="${id}"><button type="button" class="c-row" data-act="app" data-id="${id}" aria-label="${esc(label)}"><span class="c-initial" aria-hidden="true">${esc(a.name[0])}</span><span class="c-row-main"><span class="c-row-name">${esc(a.name)}</span><span class="c-row-sub">${esc(a.summary)}</span></span><span class="c-row-end">${end}</span></button></li>`;
  }

  function browse() {
    const title = `<h2 id="c-section-title" tabindex="-1">Browse</h2>`;
    if (ui.catalog === "loading") return `${title}<ul class="c-rows" aria-busy="true" aria-label="Loading the catalog"><li class="c-grey"></li><li class="c-grey"></li><li class="c-grey"></li><li class="c-grey"></li></ul>`;
    if (ui.catalog === "refused") return `${title}<div class="c-note c-note--danger" role="alert"><p><strong>Couldn't load the catalog.</strong> The gateway did not answer.</p><div class="c-actions"><button type="button" class="c-btn" data-act="catalog-retry">Try again</button></div></div>`;
    const offline = ui.catalog === "offline";
    const q = ui.search.trim().toLowerCase();
    const ids = Object.keys(inv.apps).filter((id) => !offline || inv.apps[id].installed);
    const match = (id) => !q || `${inv.apps[id].name} ${inv.apps[id].summary}`.toLowerCase().includes(q);
    const inChip = (id) => ui.chip === "all" || inv.apps[id].category === ui.chip;
    const search = `<div class="c-search" role="search"><label for="c-search" class="visually-hidden">${offline ? "Search what's on this gateway" : "Search apps and skills"}</label><input class="c-input" id="c-search" type="search" placeholder="${offline ? "Search what's on this gateway" : "Search apps and skills"}" value="${esc(ui.search)}"></div>`;
    const note = offline
      ? `<div class="c-note" role="note"><p><strong>The catalog can't be reached from the gateway.</strong> You can still see what's on this gateway.</p><details class="c-fold"><summary>Details</summary><p class="c-mono">ClawHub is unavailable: fetch failed. Installed plugins remain available.</p></details><div class="c-actions"><button type="button" class="c-btn" data-act="catalog-retry">Try again</button></div></div>`
      : "";
    const chips = offline || q
      ? ""
      : `<div class="c-chips" role="radiogroup" aria-label="Categories">${[["all", "All"], ["productivity", "Productivity"], ["finance", "Finance"], ["travel", "Travel"]]
          .map(([id, label]) => `<button type="button" class="c-chip" role="radio" data-act="chip" data-id="${id}" aria-checked="${ui.chip === id}" tabindex="${ui.chip === id ? 0 : -1}">${label}</button>`)
          .join("")}</div>`;
    const featured = offline || q || ui.chip !== "all" ? "" : `<h3>Featured</h3><ul class="c-rows" aria-label="Featured">${ids.filter((id) => inv.apps[id].featured).map(appRow).join("")}</ul>`;
    const shown = ids.filter((id) => match(id) && inChip(id));
    const allTitle = offline ? "On this gateway" : q ? "Apps" : "All apps";
    const rows = shown.length
      ? `<ul class="c-rows" aria-label="${allTitle}">${shown.map(appRow).join("")}</ul>`
      : `<p role="status">${offline ? "No installed apps match on this gateway." : "No apps match."}</p>`;
    const skills = q && !offline ? `<h3>Skills</h3><p class="c-faint">No skills match.</p>` : q && offline ? `<h3>Skills</h3><p class="c-faint">Searching skills needs the catalog.</p>` : "";
    return `${title}${readonlyNote("Plugins and tool servers")}${note}${search}${chips}${featured}<h3>${allTitle}</h3>${rows}${skills}`;
  }

  function onGateway() {
    const ids = Object.keys(inv.apps).filter((id) => inv.apps[id].installed);
    return `<h2 id="c-section-title" tabindex="-1">On this gateway</h2>${readonlyNote("Plugins and tool servers")}<h3>Turned on</h3><ul class="c-rows" aria-label="Turned on">${ids.filter((id) => inv.apps[id].state !== "disabled").map(appRow).join("") || "<li class='c-row'>None</li>"}</ul><h3>Turned off</h3>${ids.some((id) => inv.apps[id].state === "disabled") ? `<ul class="c-rows" aria-label="Turned off">${ids.filter((id) => inv.apps[id].state === "disabled").map(appRow).join("")}</ul>` : `<p class="c-faint">None</p>`}<details class="c-fold"><summary>Comes with OpenClaw (64)</summary><p class="c-faint">The gateway's own plugins.</p></details><div class="c-actions"><button type="button" class="c-btn" data-act="to-servers">Tool servers: ${Object.keys(inv.servers).length}</button></div>`;
  }

  function appScreen() {
    const id = ui.app;
    const a = inv.apps[id];
    const back = `<button type="button" class="c-btn c-btn--quiet c-back" data-act="apps-nav" data-id="${a?.installed ? "gateway" : "browse"}">Back</button>`;
    if (!a) return back;
    const head = `<div class="c-page-head"><span class="c-initial c-initial--lg" aria-hidden="true">${esc(a.name[0])}</span><div><h2 id="c-section-title" tabindex="-1">${esc(a.name)}</h2><p class="c-faint">by ${esc(a.author)}${a.official ? " · Official" : ""}</p></div></div>`;
    const result = ui.result?.where === "app" ? `<div class="c-result" role="status"><p>${ui.result.html}</p></div>` : "";
    const busy = ui.busy ? `<p class="c-faint" role="status">${esc(ui.busy)}</p>` : "";
    if (!a.installed) {
      const add = a.unavailable ? `<p class="c-faint">Not available for this gateway.</p>` : canWrite() && ui.catalog !== "offline" ? `<div class="c-actions"><button type="button" class="c-btn c-btn--primary" data-act="app-add" data-id="${id}" id="c-app-add">Add</button></div>` : accessBar("Adding apps needs admin access.");
      return `${back}${head}${readonlyNote("Plugins and tool servers")}${result}${busy}<p>${esc(a.summary)}</p><h3>What it adds</h3><ul class="c-tools"><li><span class="c-mono">${esc(id)}</span>, a tool server${a.official ? " that signs in with an account" : ""}</li><li>A skill, ${esc(a.name)} basics</li></ul><h3>About</h3><p class="c-faint">Version ${esc(a.versionText ?? "picked by the gateway")}</p>${add}`;
    }
    const state = a.state === "disabled" ? "Turned off." : "Added";
    const accounts = a.accounts && a.state !== "disabled"
      ? `<h3>Accounts</h3><ul class="c-rows" aria-label="Accounts">${a.accounts
          .map((acc) => {
            const words = { authorized: "Signed in. The gateway reports saved sign-in tokens.", unauthenticated: "Needs sign-in.", "requires-authorization": "Needs sign-in again.", "pending-authorization": "Sign-in pending." }[acc.state];
            const act = canWrite() ? (acc.state === "authorized" ? (version === V11 ? `<button type="button" class="c-btn" data-act="noop">Sign out</button>` : "") : `<button type="button" class="c-btn c-btn--primary" data-act="app-signin" data-id="${id}" data-server="${esc(acc.server)}">Sign in</button>`) : "";
            return `<li class="c-row"><span class="c-row-main"><span class="c-row-name c-mono">${esc(acc.server)}</span><span class="c-row-sub">Shared by everyone on this gateway</span></span><span class="c-row-end"><span class="c-pill${acc.state === "authorized" ? "" : " c-pill--warn"}">${esc(words)}</span>${act}</span></li>`;
          })
          .join("")}</ul>`
      : a.accounts
        ? `<p class="c-faint">The gateway reports sign-ins only while ${esc(a.name)} is turned on.</p>`
        : "";
    const actions = canWrite()
      ? `<div class="c-actions"><button type="button" class="c-btn" data-act="app-toggle" data-id="${id}" id="c-toggle">${a.state === "disabled" ? "Turn on" : "Turn off"}</button><button type="button" class="c-btn c-btn--danger" data-act="app-remove" data-id="${id}">Remove</button></div>`
      : accessBar("Changing apps needs admin access.");
    return `${back}${head}${readonlyNote("Plugins and tool servers")}${result}${busy}<p><span class="c-pill">${esc(state)}</span></p><p>${esc(a.summary)}</p>${accounts}${actions}`;
  }

  // ---------- Behaviour ----------

  async function act(button) {
    const a = button.dataset.act;
    const name = button.dataset.name;
    if (a === "noop") return;
    if (a === "nav") {
      ui.section = button.dataset.id;
      ui.screen = "list";
      ui.result = null;
      ui.pane = "section";
      render();
      return focusTitle();
    }
    if (a === "pane-nav") {
      ui.pane = "nav";
      render();
      return document.querySelector(".c-nav button[aria-current]")?.focus();
    }
    if (a === "add") {
      ui.screen = "add";
      ui.form = newForm("url");
      ui.result = null;
      render();
      return focusTitle();
    }
    if (a === "back") {
      const from = ui.screen === "server" ? ui.name : null;
      ui.screen = "list";
      ui.result = null;
      ui.signin = null;
      ui.task = null;
      ui.botStatus = {};
      render();
      return (from && document.getElementById(`c-row-${from}`)) ? document.getElementById(`c-row-${from}`).focus() : focusTitle();
    }
    if (a === "open") {
      ui.screen = "server";
      ui.name = name;
      ui.result = null;
      ui.signin = null;
      ui.task = null;
      ui.botStatus = {};
      ui.undo = null;
      render();
      return focusTitle();
    }
    if (a === "more") {
      readValues();
      ui.form.more = true;
      ui.form.headers.push({ name: "", value: "" });
      render();
      return document.querySelector('[data-header="0"][data-part="name"]')?.focus();
    }
    if (a === "add-header") {
      readValues();
      ui.form.headers.push({ name: "", value: "" });
      render();
      return;
    }
    if (a === "submit") return submit();
    if (a === "layer-cancel") return closeLayer();
    if (a === "undo-add") {
      const ending = await write(() => {
        delete inv.servers[name];
        delete inv.denied[name];
      });
      ui.screen = "list";
      ui.result = ending.kind === "ok" ? null : { where: "list", ending, reviewed: { name, bots: [] } };
      render();
      say(ending.kind === "ok" ? `Took back ${name}` : `Couldn't take back ${name}`);
      return document.getElementById("c-add")?.focus();
    }
    if (a === "check-again") return checkAgain();
    if (a === "edit-again") {
      ui.result = null;
      render();
      return document.getElementById("c-submit")?.focus();
    }
    if (a === "try") {
      ui.screen = "server";
      ui.name = name;
      ui.result = null;
      ui.task = { bot: button.dataset.bot, server: name, text: `What can you do with ${name}?`, sent: false };
      render();
      const field = document.getElementById("c-message");
      field?.focus();
      field?.setSelectionRange(field.value.length, field.value.length);
      return;
    }
    if (a === "send") return sendTry();
    if (a === "remove") {
      const s = inv.servers[name];
      const loses = s.headers?.length || (s.oauth && version === V11);
      if (loses) {
        ui.layer = { kind: "remove", name };
        ui.returnFocus = "c-remove";
        render();
        return;
      }
      return removeServer(name);
    }
    if (a === "remove-confirm") {
      ui.layer = null;
      return removeServer(name);
    }
    if (a === "undo") return undoRemove();
    if (a === "signin") return startSignin(name);
    if (a === "signin-open") {
      say("Opened the gateway's page");
      return;
    }
    if (a === "signin-back") {
      ui.signin = { stage: "back" };
      if (ui.signinSaves) inv.signedIn[name] = true;
      render();
      return document.getElementById("c-try-after")?.focus();
    }
    if (a === "copy-secret") {
      try {
        await navigator.clipboard.writeText("example-gateway-secret");
        ui.signin.copied = "ok";
      } catch {
        ui.signin.copied = "failed";
      }
      render();
      return document.getElementById("c-copy")?.focus();
    }
    if (a === "pair-approve") {
      ui.layer = null;
      ui.signin.approved = true;
      render();
      say("Browser approved");
      return document.getElementById("c-back-here")?.focus();
    }
    if (a === "pair-reject") {
      ui.layer = null;
      ui.signin.code = "";
      ui.signin.codeError = "Rejected. Choose Pair this browser again on the gateway's page if you meant to.";
      render();
      return document.getElementById("c-code")?.focus();
    }
    if (a === "signout") {
      ui.layer = { kind: "signout", name };
      ui.returnFocus = "c-signout";
      render();
      return;
    }
    if (a === "signout-confirm") {
      ui.layer = null;
      ui.busy = "Signing out…";
      render();
      await wait();
      ui.busy = null;
      inv.signedIn[name] = false;
      inv.servers[name].reach = { kind: "signin", bot: serverBots(name)[0], time: "now" };
      ui.result = { where: "server", html: `Signed out of ${esc(name)}. Bots that use it need a new sign-in.` };
      render();
      say(`Signed out of ${name}`);
      return;
    }
    if (a === "reach-again") {
      inv.servers[name].reach = { kind: "notyet" };
      render();
      return;
    }
    if (a === "access-request") {
      ui.request = "asking";
      render();
      await wait();
      ui.request = "requested";
      render();
      return document.querySelector('[data-act="access-check"]')?.focus();
    }
    if (a === "access-check") {
      ui.request = null;
      ui.access = "admin";
      render();
      say("Admin access granted");
      return focusTitle();
    }
    if (a === "reload") {
      ui.loadfail = false;
      render();
      return focusTitle();
    }
    // Slice 2
    if (a === "apps-nav") {
      ui.screen = button.dataset.id;
      ui.result = null;
      ui.pane = "section";
      render();
      return focusTitle();
    }
    if (a === "app") {
      ui.screen = "app";
      ui.app = button.dataset.id;
      ui.result = null;
      render();
      return focusTitle();
    }
    if (a === "chip") {
      ui.chip = button.dataset.id;
      render();
      return document.querySelector(`.c-chip[data-id="${ui.chip}"]`)?.focus();
    }
    if (a === "catalog-retry") {
      ui.catalog = "loading";
      render();
      await wait();
      ui.catalog = "loaded";
      render();
      say(`${Object.keys(inv.apps).length} apps`);
      return focusTitle();
    }
    if (a === "app-add") {
      ui.layer = { kind: "app-add", id: button.dataset.id };
      ui.returnFocus = "c-app-add";
      render();
      return;
    }
    if (a === "app-add-confirm") {
      const id = button.dataset.id;
      ui.layer = null;
      for (const stage of ["Finding the release", "Downloading", "Unpacking", "Writing files", "Installing what it needs", "Starting it on the gateway"]) {
        ui.busy = `${stage}…`;
        render();
        await wait(delay / 3);
      }
      ui.busy = null;
      inv.apps[id].installed = true;
      inv.apps[id].state = "enabled";
      ui.result = { where: "app", html: `<strong>Added ${esc(inv.apps[id].name)}.</strong> The gateway lists it as installed and turned on.` };
      render();
      say(`Added ${inv.apps[id].name}`);
      return document.getElementById("c-toggle")?.focus();
    }
    if (a === "app-toggle") {
      const app = inv.apps[button.dataset.id];
      ui.busy = "Checking what the gateway has…";
      render();
      await wait();
      ui.busy = null;
      app.state = app.state === "disabled" ? "enabled" : "disabled";
      ui.result = { where: "app", html: app.state === "disabled" ? "Turned off. Its settings and any saved sign-ins stay." : "Turned on." };
      render();
      say(app.state === "disabled" ? `Turned off ${app.name}` : `Turned on ${app.name}`);
      return document.getElementById("c-toggle")?.focus();
    }
    if (a === "app-remove") {
      ui.layer = { kind: "app-remove", id: button.dataset.id };
      ui.returnFocus = null;
      render();
      return;
    }
    if (a === "app-remove-confirm") {
      const app = inv.apps[button.dataset.id];
      ui.layer = null;
      ui.busy = "Checking what the gateway has…";
      render();
      await wait();
      ui.busy = null;
      app.installed = false;
      delete app.state;
      ui.screen = "gateway";
      render();
      say(`Removed ${app.name}`);
      return focusTitle();
    }
    if (a === "app-signin") {
      ui.result = { where: "app", html: `<strong>The gateway's page for ${esc(inv.apps[button.dataset.id].name)} is open in your browser.</strong> Sign in to ${esc(button.dataset.server)} under Accounts there, then come back. <button type="button" class="c-btn" data-act="app-back" data-id="${esc(button.dataset.id)}" data-server="${esc(button.dataset.server)}" id="c-app-back">I'm back</button>` };
      render();
      return document.getElementById("c-app-back")?.focus();
    }
    if (a === "app-back") {
      ui.busy = `Reading ${inv.apps[button.dataset.id].name}'s accounts…`;
      render();
      await wait();
      ui.busy = null;
      const acc = inv.apps[button.dataset.id].accounts.find((x) => x.server === button.dataset.server);
      if (ui.signinSaves) acc.state = "authorized";
      ui.result = { where: "app", html: ui.signinSaves ? `${esc(acc.server)}: signed in. The gateway reports saved sign-in tokens.` : `${esc(acc.server)} still needs sign-in.` };
      render();
      return focusTitle();
    }
    if (a === "to-servers") {
      ui.view = "settings";
      ui.section = "servers";
      ui.screen = "list";
      render();
      return focusTitle();
    }
  }

  async function sendTry() {
    const t = ui.task;
    t.text = document.getElementById("c-message").value;
    t.sent = "running";
    render();
    await wait(delay * 2);
    const s = inv.servers[t.server];
    if (s.oauth && !inv.signedIn[t.server]) {
      s.reach = { kind: version === V11 ? "signin" : "refused401", bot: t.bot, time: "5:20 PM" };
      t.reply = `I couldn't use ${t.server}: it needs a sign-in.`;
    } else if (s.kind === "command" && s.command.startsWith("/nonexistent")) {
      s.reach = { kind: "nostart", bot: t.bot, time: "5:20 PM" };
      t.reply = `I couldn't start ${t.server}.`;
    } else {
      const tools = s.reach.tools ?? [["search", "Search."], ["read", "Read one item."]];
      s.reach = { kind: "tools", bot: t.bot, time: "5:20 PM", tools };
      t.reply = `I can use ${tools.length} tools from ${t.server}.`;
    }
    t.sent = true;
    ui.signin = null;
    render();
    say(`${botName(t.bot)} answered`);
    focusTitle();
  }

  async function removeServer(name) {
    const before = { entry: inv.servers[name], denied: inv.denied[name] };
    const ending = await write(() => {
      delete inv.servers[name];
      delete inv.denied[name];
    });
    if (ending.kind === "ok" || ending.kind === "matchedNoAnswer") {
      ui.screen = "list";
      ui.signin = null;
      ui.task = null;
      ui.undo = before.entry.headers?.length || (before.entry.oauth && version === V11) ? null : { name, ...before };
      ui.result = ui.undo ? null : { where: "list", kind: "removed" };
      render();
      say(`Removed ${name}`);
      if (!ui.undo) {
        const live = document.querySelector(".c-section");
        live?.insertAdjacentHTML("afterbegin", "");
      }
      const next = document.querySelector(".c-rows .c-row") ?? document.getElementById("c-add");
      return (ui.undo ? document.getElementById("c-undo") : next)?.focus();
    }
    ui.result = {
      where: "server",
      html:
        ending.kind === "refused"
          ? `<strong>Couldn't remove ${esc(name)}:</strong> the gateway is busy with another change. Try again in a moment.`
          : ending.kind === "stale"
            ? `<strong>The gateway's settings changed</strong> while you were here. Check the server below and try again.`
            : ending.kind === "absent"
              ? `Removed ${esc(name)}. The gateway's settings no longer have it.`
              : `<strong>Couldn't confirm the change.</strong> The gateway's settings couldn't be read.`,
    };
    if (ending.kind === "absent") {
      delete inv.servers[name];
      ui.screen = "list";
      ui.result = null;
    }
    render();
    focusTitle();
  }

  async function undoRemove() {
    const u = ui.undo;
    const ending = await write(() => {
      inv.servers[u.name] = u.entry;
      inv.denied[u.name] = u.denied;
    });
    ui.undo = null;
    ui.result = ending.kind === "ok" ? null : { where: "list", ending, reviewed: { name: u.name, bots: [] } };
    render();
    say(ending.kind === "ok" ? `Put back ${u.name}` : `Couldn't put back ${u.name}`);
    document.getElementById(`c-row-${u.name}`)?.focus();
  }

  function startSignin(name) {
    ui.screen = "server";
    ui.name = name;
    ui.result = null;
    ui.task = null;
    ui.signin = ui.pageAddr === "none" ? { stage: "noaddress" } : { stage: "open", code: "" };
    render();
    say(ui.pageAddr === "none" ? "Signing in needs the gateway's page" : "Opened the gateway's page");
    (document.getElementById("c-code") ?? document.getElementById("c-copy") ?? document.getElementById("c-back-here") ?? document.querySelector(".c-note[role=alert]"))?.focus();
  }

  async function codeTyped(input) {
    const raw = input.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const formatted = raw.length > 4 ? `${raw.slice(0, 4)}-${raw.slice(4)}` : raw;
    input.value = formatted;
    ui.signin.code = formatted;
    ui.signin.codeError = null;
    if (raw.length < 8) return;
    const outcome = ui.codeOutcome;
    ui.codeOutcome = "ok";
    await wait(delay / 2);
    if (outcome === "expired" || outcome === "unknown") {
      ui.signin.codeError =
        outcome === "expired" ? "This code has expired. Choose Pair this browser again on the gateway's page." : "No browser is waiting for this code. Check the code on the gateway's page.";
      render();
      return document.getElementById("c-code")?.focus();
    }
    ui.layer = { kind: "pair", code: formatted };
    ui.returnFocus = "c-code";
    render();
  }

  async function botToggled(input) {
    const bot = input.dataset.bot;
    const name = ui.name;
    const want = input.checked;
    ui.botStatus = { ...ui.botStatus, [bot]: "saving" };
    render();
    await wait();
    const outcome = ui.botWrite;
    ui.botWrite = "accepted";
    if (outcome === "refused") {
      ui.botStatus = { ...ui.botStatus, [bot]: `Couldn't change ${botName(bot)}: the gateway is busy with another change. Try again in a moment.` };
    } else {
      const denied = inv.denied[name] ?? [];
      inv.denied[name] = want ? denied.filter((id) => id !== bot) : [...denied, bot];
      const { [bot]: _gone, ...rest } = ui.botStatus;
      ui.botStatus = rest;
      say(want ? `${botName(bot)} can use ${name}` : `${botName(bot)} can't use ${name} now`);
    }
    render();
    document.getElementById(`c-bot-${bot}`)?.focus();
  }

  function closeLayer() {
    const back = ui.returnFocus;
    ui.layer = null;
    render();
    if (back) document.getElementById(back)?.focus();
  }

  function focusTitle() {
    document.getElementById("c-section-title")?.focus();
  }

  // ---------- Events ----------

  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (extra) {
      extra.innerHTML = `<label>Next write <select id="proto-write">${["accepted", "refused", "noanswer", "stale", "differs"].map((v) => `<option${v === ui.nextWrite ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <label>Read after it <select id="proto-read">${["matches", "absent", "fails"].map((v) => `<option${v === ui.nextRead ? " selected" : ""}>${v}</option>`).join("")}</select></label>
        <span>OpenClaw ${version}</span>`;
      extra.addEventListener("change", (event) => {
        if (event.target.id === "proto-write") ui.nextWrite = event.target.value;
        if (event.target.id === "proto-read") ui.nextRead = event.target.value;
      });
    }
    const app = document.getElementById("c-root");
    app.addEventListener("click", (event) => {
      const button = event.target.closest("[data-act]");
      if (button && !button.disabled) void act(button);
    });
    app.addEventListener("change", (event) => {
      const t = event.target;
      if (t.matches(".c-bots input[data-bot]") && ui.screen === "server") void botToggled(t);
      if (t.name === "c-kind") {
        readValues();
        ui.form.kind = t.value;
        ui.form.errors = {};
        render();
        document.getElementById(`c-kind-${t.value}`)?.focus();
      }
    });
    app.addEventListener("input", (event) => {
      const t = event.target;
      if (t.id === "c-url" && ui.form && !ui.form.nameEdited) {
        const name = document.getElementById("c-name");
        if (name) name.value = nameFromUrl(t.value);
      }
      if (t.id === "c-name" && ui.form) ui.form.nameEdited = true;
      if (["c-command", "c-args", "c-cwd"].includes(t.id) && ui.form) {
        const draft = { ...ui.form, command: document.getElementById("c-command").value, args: document.getElementById("c-args").value, cwd: document.getElementById("c-cwd").value };
        document.getElementById("c-runs").innerHTML = runsLine(reviewed(draft));
      }
      if (t.id === "c-code") void codeTyped(t);
      if (t.id === "c-search") {
        ui.search = t.value;
        render();
        const s = document.getElementById("c-search");
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
        say(document.querySelector(".c-section [role=status]")?.textContent || "Showing matches");
      }
    });
    app.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (ui.layer) {
          event.preventDefault();
          return closeLayer();
        }
        if (event.target.id === "c-search" && ui.search) {
          event.preventDefault();
          ui.search = "";
          render();
          return document.getElementById("c-search")?.focus();
        }
      }
      if (event.key === "Tab" && ui.layer) {
        const focusable = [...document.querySelectorAll(".c-dialog button")];
        const i = focusable.indexOf(document.activeElement);
        if (event.shiftKey && i <= 0) {
          event.preventDefault();
          focusable[focusable.length - 1].focus();
        } else if (!event.shiftKey && i === focusable.length - 1) {
          event.preventDefault();
          focusable[0].focus();
        }
      }
      if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && event.target.matches(".c-chip")) {
        const chips = [...document.querySelectorAll(".c-chip")];
        const i = chips.indexOf(event.target);
        const next = chips[(i + (event.key === "ArrowRight" ? 1 : chips.length - 1)) % chips.length];
        ui.chip = next.dataset.id;
        render();
        document.querySelector(`.c-chip[data-id="${ui.chip}"]`)?.focus();
      }
    });
    addEventListener("resize", narrow);
    document.addEventListener("ct:settings", () => setTimeout(narrow, 0));
    render();
    if (ui.screen === "server" && P.get("signin") === "open") startSignin(ui.name);
    window.connectorsPrototype = { inv, ui };
  });
})();
