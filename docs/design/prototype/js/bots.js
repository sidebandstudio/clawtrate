// Bots, accounts and T3 Code: the screens in docs/design/bots.md, on top of the
// shell in app.js. None of this talks to a gateway. Accounts, sign-ins and
// models are local fixtures; the provider labels, links and codes are samples.
//
// The address picks a state, which is how the screenshots are taken:
//   open=create|settings     a dialog to open on load
//   step=look|account|connect (create)   section=accounts (settings)
//   account=<profile id>     an account's page in Settings
//   connect=<auth choice>    a sign-in method, with stage=starting|waiting|entering|
//                            checking|connected|failed|expired|cancelled|dropped|busy|domain
//   apikey=open              the API key form, opened
//   access=read|write|admin  what the connection may do (default admin)
//   req=asking|requested|denied|expired|failed|granted   the request for admin access
//   accounts=none            no account connected yet
//   chosen=<profile id>      the account chosen in the Account step
//   create=creating|slow|failed
//   name=<text>              the new bot's name

(function () {
  const CT = window.CT;
  const app = window.app;
  const params = CT.params;
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const esc = (text) =>
    String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const icon = (name, cls) => CT.icon(name, cls);
  const p = (name) => params.get(name);

  // Fixtures -------------------------------------------------------------------------------------

  const PROVIDERS = { xai: "xAI", openai: "OpenAI", "github-copilot": "GitHub Copilot", anthropic: "Anthropic", minimax: "MiniMax", openrouter: "OpenRouter" };

  // kind: subscription (a sign-in Clawtrate started and knows is a plan), key
  // (an API key, or a sign-in that saves one), gateway (added on the gateway;
  // its storage type alone does not say how it is billed).
  let accounts = [
    { id: "openai:work", provider: "openai", label: "Work", kind: "subscription", how: "ChatGPT sign-in with a code", status: "ok" },
    { id: "openai:home", provider: "openai", label: "Home", kind: "subscription", how: "ChatGPT sign-in in the browser", status: "expiring", expiry: "in 3 days", expiryDate: "Nov 20" },
    { id: "xai:default", provider: "xai", label: "Personal", kind: "subscription", how: "xAI sign-in with a code", status: "ok" },
    { id: "github-copilot:github", provider: "github-copilot", label: "", kind: "subscription", how: "GitHub sign-in with a code", status: "ok" },
    { id: "anthropic:manual", provider: "anthropic", label: "Lab key", kind: "key", how: "API key, entered in Clawtrate", status: "static" },
  ];
  if (p("accounts") === "none") accounts = [];

  // Each bot's binding: its account, model and effort, and whether the gateway
  // has a one-account order for it (locked). account null: no account of its own.
  const binding = {
    otto: { account: "openai:work", model: "gpt-5.5", effort: "Medium", locked: true },
    marlow: { account: "openai:work", model: "gpt-5.5", effort: "Low", locked: false },
    pip: { account: "openai:home", model: "gpt-5.5-mini", effort: "Low", locked: false },
    juniper: { account: "anthropic:manual", model: "claude-sonnet-5.5", effort: "High", locked: false },
  };
  if (p("accounts") === "none") Object.values(binding).forEach((b) => (b.account = null));

  // Models the gateway lists for each provider, and the effort levels it offers.
  const MODELS = {
    xai: ["grok-4.7", "grok-4.6", "grok-4.5", "grok-build-0.1"],
    openai: ["gpt-5.5", "gpt-5.5-mini", "gpt-5.5-codex"],
    "github-copilot": ["gpt-5.5", "claude-sonnet-5.5"],
    anthropic: ["claude-sonnet-5.5", "claude-opus-5.5"],
    minimax: ["minimax-m3"],
    openrouter: ["openrouter/auto"],
  };
  const EFFORTS = ["Off", "Low", "Medium", "High"];
  const DEFAULT_MODEL = { provider: "openai", model: "gpt-5.5" }; // agents.defaults.model.primary, with no @account

  // The sign-in methods the gateway can start, as it lists them. flow is what
  // the person does: code (open a link, enter a code; the gateway polls), paste
  // (open a link, paste a code back), host (finishes on the gateway's machine),
  // domain (a company address first, then a code).
  const OPTIONS = [
    { id: "xai/xai-oauth", provider: "xai", label: "xAI", hint: "SuperGrok or X Premium", flow: "code", group: "sub" },
    { id: "openai/openai-device-code", provider: "openai", label: "ChatGPT", hint: "Plus, Pro or Business", flow: "code", group: "sub" },
    { id: "openai/openai", provider: "openai", label: "ChatGPT in the browser", hint: "Plus, Pro or Business", flow: "paste", group: "sub" },
    { id: "openai/openai-token-sharing", provider: "openai", label: "Sign in with ChatGPT", hint: "Plus, Pro or Business", flow: "host", group: "sub" },
    { id: "github-copilot/github-copilot", provider: "github-copilot", label: "GitHub Copilot", hint: "Copilot subscription", flow: "code", group: "sub" },
    { id: "github-copilot/github-copilot-enterprise", provider: "github-copilot", label: "GitHub Copilot Enterprise", hint: "Your company's GitHub", flow: "domain", group: "sub" },
    { id: "minimax/minimax-global-oauth", provider: "minimax", label: "MiniMax", hint: "Coding plan", flow: "code", group: "sub" },
    { id: "openrouter/openrouter-oauth", provider: "openrouter", label: "OpenRouter", hint: "Credits", flow: "paste", group: "token" },
  ];
  const FLOW_WORDS = {
    code: "Open a page and enter a code",
    paste: "Open a page, then paste a code back here",
    host: "Finishes in a browser on the gateway's machine",
    domain: "Your company's GitHub address, then a code",
  };
  const KEY_PROVIDERS = ["openai", "anthropic", "xai", "openrouter", "minimax"];

  const BOT_ART_BODIES = ["pebble", "block", "arch", "bloom", "disc", "hex", "drop", "gem"];
  const BOT_ART_COLORS = ["#58c26f", "#5b8dff", "#ff8552", "#a98bff", "#f6bd3b", "#ff6f9c", "#45bdf5", "#a5d955"];

  // State ------------------------------------------------------------------------------------------

  const B = {
    access: ["read", "write", "admin"].includes(p("access")) ? p("access") : "admin",
    req: p("req") || "none", // the request for admin access
    draft: { name: p("name") ?? "", body: "drop", color: "#ff6f9c", account: p("chosen") || null, model: null, effort: "Medium" },
    create: { step: p("step") || "look", status: p("create") || "idle", opener: null },
    connect: null, // { from, view, option, stage, ... }
    settings: { section: p("section") || "accounts", account: p("account") || null, pane: p("account") || p("section") ? "section" : "nav", edit: false },
    seconds: 4,
    grantedNote: false,
  };
  if (B.draft.account) B.draft.model = MODELS[acct(B.draft.account)?.provider]?.[0] || null;

  function acct(id) {
    return accounts.find((a) => a.id === id) || null;
  }
  const isAdmin = () => B.access === "admin";
  const providerName = (id) => PROVIDERS[id] || id;
  // Labels reach admin connections only, so below admin an account is its provider.
  const acctName = (a) => (!a ? "No account" : isAdmin() ? `${providerName(a.provider)}${a.label ? ` · ${a.label}` : ""}` : `${providerName(a.provider)} ${a.id}`);
  // Below admin the gateway sends no label, so the row shows the account's id
  // on the gateway, which is what tells two accounts of one provider apart there.
  const acctTitle = (a) =>
    isAdmin()
      ? a.label
        ? `${esc(providerName(a.provider))} <span>· ${esc(a.label)}</span>`
        : esc(providerName(a.provider))
      : `${esc(providerName(a.provider))} <span class="mono">${esc(a.id)}</span>`;
  const kindWord = (a) => ({ subscription: "Subscription", key: "API key", gateway: "Added on the gateway" })[a.kind];
  const usedBy = (id) =>
    Object.entries(binding)
      .filter(([, b]) => b.account === id)
      .map(([bot]) => app.bots.find((x) => x.id === bot)?.name)
      .filter(Boolean);
  const stateOf = (a) =>
    ({
      ok: ["", "Connected"],
      static: ["", "Connected"],
      expiring: ["warn", `Expires ${a.expiry}`],
      expired: ["danger", "Expired"],
      missing: ["warn", "Needs sign-in"],
    })[a.status];
  const ordered = () => [...accounts].sort((x, y) => ["subscription", "key", "gateway"].indexOf(x.kind) - ["subscription", "key", "gateway"].indexOf(y.kind));

  function announce(text) {
    const live = $("#b-announce");
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  }

  // Small pieces -----------------------------------------------------------------------------------

  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${label}</button>`;
  const close = (label) => `<button type="button" class="icon-button b-close" data-b="close" aria-label="${label}">${icon("x")}</button>`;
  const back = (label, action) => `<button type="button" class="icon-button b-back" data-b="${action}" aria-label="${label}">${icon("back")}</button>`;
  const copy = (what, text) => CT.copyButton ? CT.copyButton(what, text) : `<button type="button" class="copy" aria-label="Copy ${esc(what)}" data-what="${esc(what)}" data-copy="${esc(text)}">${icon("copy")}</button>`;
  const note = (html, tone = "", lead = "") =>
    `<div class="b-note"${tone ? ` data-tone="${tone}"` : ""}>${lead || icon(tone ? "warning" : "clock")}<div>${html}</div></div>`;
  const glyph = (state) => `<span class="glyph" data-state="${state}" aria-hidden="true"></span>`;
  const wait = (text) => `<p class="b-wait" role="status"><span class="status-dot" data-status="connecting"></span>${text}</p>`;
  const result = (tone, mark, title, text) =>
    `<div class="b-result"><span class="empty-mark" data-tone="${tone}">${icon(mark)}</span><h3 tabindex="-1" data-b-focus>${title}</h3><p>${text}</p></div>`;

  // A character drawn from the draft's body and colour, through the shell's own drawing.
  function draftArt() {
    CT.botArt.__draft = { body: B.draft.body, color: B.draft.color, tilt: 0, look: [0.6, 0] };
    return CT.character("__draft");
  }

  // The request for admin access: the access bar of conversation.md section 3,
  // with words for what this screen needs.
  const REQUEST = "3f9a2c71";
  function adminBar(need) {
    if (B.grantedNote)
      return `<section class="access-bar" role="region" aria-label="Access" data-state="granted"><div class="access-row">${glyph("done")}<span class="shelf-text"><b>Admin access granted.</b> You can change this now.</span></div></section>`;
    const rows = {
      none: [`${icon("eye")}<span class="shelf-text"><b>${B.access === "read" ? "Read-only." : "Admin access needed."}</b> ${need}</span>`, button("Request admin access", 'data-b="request" data-size="sm"', "primary")],
      asking: [`${glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`, ""],
      requested: [`${glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span>`, ""],
      denied: [`${glyph("stopped")}<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device keeps the access it had.</span>`, button("Request again", 'data-b="request" data-size="sm"')],
      expired: [`${glyph("stopped")}<span class="shelf-text"><b>The request expired</b> before it was approved.</span>`, button("Request again", 'data-b="request" data-size="sm"')],
      failed: [`${icon("warning")}<span class="shelf-text"><b>Couldn't send the request.</b> The gateway did not answer.</span>`, button("Try again", 'data-b="request" data-size="sm"')],
    };
    const [text, actions] = rows[B.req] || rows.none;
    const command = `openclaw devices approve ${REQUEST}`;
    return (
      `<section class="access-bar" role="region" aria-label="Access" data-state="${B.req}"${B.req === "failed" ? ' data-tone="danger"' : ""}>` +
      `<div class="access-row">${text}${actions}</div>` +
      (B.req === "requested"
        ? `<div class="command-line"><code>${command}</code>${copy("approve command", command)}</div>` +
          `<div class="access-row"><span class="access-id">Request <span class="mono">${REQUEST}</span>${copy("request id", REQUEST)}` +
          `<span class="access-wait">checking again in ${B.seconds}s</span></span><span class="spacer"></span>` +
          button("Check now", 'data-b="request-check" data-size="sm"') +
          button("Cancel request", 'data-b="request-cancel" data-size="sm"', "quiet") +
          `</div>`
        : "") +
      `</section>`
    );
  }

  // The account rows: the Account step, changing a bot's account, and Settings.
  function accountRow(a, { choose = false, checked = false, open = false } = {}) {
    const [tone, word] = stateOf(a);
    const users = usedBy(a.id);
    const sub =
      `${kindWord(a)}` +
      (tone ? ` · <span data-tone="${tone}">${word}</span>` : "") +
      ` · ${users.length ? esc(users.join(", ")) : "Not used yet"}`;
    const text = `<span class="b-choice-text"><span class="b-choice-title">${acctTitle(a)}</span><span class="b-choice-sub">${sub}</span></span>`;
    if (choose)
      return `<li><button type="button" class="b-choice" role="radio" aria-checked="${checked}" tabindex="${checked ? 0 : -1}" data-b-choose="${a.id}"${isAdmin() ? "" : ' aria-disabled="true"'}>${text}${icon("check", "icon b-tick")}</button></li>`;
    if (open) return `<li><button type="button" class="b-choice" data-b-account="${a.id}">${text}${icon("chevron")}</button></li>`;
    return `<li><div class="b-choice">${text}</div></li>`;
  }

  function accountGroups(render) {
    const groups = [
      ["Subscriptions", accounts.filter((a) => a.kind === "subscription")],
      ["API keys", accounts.filter((a) => a.kind === "key")],
      ["Added on the gateway", accounts.filter((a) => a.kind === "gateway")],
    ].filter(([, list]) => list.length);
    return groups.map(([title, list]) => `<h4 class="b-group">${title}</h4><ul class="b-choices"${render.group || ""}>${list.map(render.row).join("")}</ul>`).join("");
  }

  // New bot -------------------------------------------------------------------------------------------

  const createDialog = $("#create-dialog");

  function openCreate(opener) {
    B.create.opener = opener || document.activeElement;
    if (B.create.status !== "creating" && B.create.status !== "slow") B.create.status = p("create") && !B.create.opened ? p("create") : "idle";
    B.create.opened = true;
    renderCreate();
    if (!createDialog.open) createDialog.showModal();
    focusFirst(createDialog);
  }

  function renderCreate() {
    const step = B.create.step;
    let head = "";
    let body = "";
    let foot = "";
    if (step === "look") {
      head = `<header class="b-head"><h2 id="create-title" tabindex="-1">New bot</h2>${close("Close")}</header>`;
      body =
        `<span class="b-preview" role="img" aria-label="${esc(B.draft.name || "New bot")}'s picture">${draftArt()}</span>` +
        `<label class="visually-hidden" for="b-name">Name</label>` +
        `<input class="input b-name" id="b-name" data-b-focus autocomplete="off" maxlength="40" placeholder="Name" value="${esc(B.draft.name)}" />` +
        `<p class="b-label" id="b-shape-label">Shape</p><div class="b-shapes" role="radiogroup" aria-labelledby="b-shape-label">` +
        BOT_ART_BODIES.map((body) => {
          CT.botArt.__shape = { body, color: B.draft.color, tilt: 0, look: [0.6, 0] };
          const on = body === B.draft.body;
          return `<button type="button" class="b-shape" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${body}" data-b-body="${body}">${CT.character("__shape")}</button>`;
        }).join("") +
        `</div><p class="b-label" id="b-color-label">Colour</p><div class="b-colors" role="radiogroup" aria-labelledby="b-color-label">` +
        BOT_ART_COLORS.map((color, i) => {
          const on = color === B.draft.color;
          const names = ["Green", "Blue", "Orange", "Violet", "Yellow", "Pink", "Sky", "Lime"];
          return `<button type="button" class="b-color" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" aria-label="${names[i]}" style="--swatch:${color}" data-b-color="${color}"></button>`;
        }).join("") +
        `</div>`;
      foot = button("Next", 'data-b="next" data-size="lg"', "primary");
    } else if (step === "account") {
      const name = B.draft.name.trim() || "New bot";
      head = `<header class="b-head">${back("Back to the picture", "to-look")}<h2 id="create-title" tabindex="-1">Account</h2>${close("Close")}</header>`;
      body =
        `<span class="b-preview" style="--avatar-create:56px;margin-bottom:10px" aria-hidden="true">${draftArt()}</span>` +
        `<p class="b-lead">Choose the account ${esc(name)} runs on. The sign-in stays on your gateway.</p>` +
        (accounts.length
          ? accountGroups({ group: ` role="radiogroup" aria-label="Accounts"`, row: (a) => accountRow(a, { choose: true, checked: a.id === B.draft.account }) }) +
            `<ul class="b-choices" style="margin-top:12px"><li><button type="button" class="b-choice" data-kind="add" data-b="connect"${isAdmin() ? "" : ' aria-disabled="true" disabled'}>${icon("plus")}<span class="b-choice-text"><span class="b-choice-title">Connect another account</span></span></button></li></ul>` +
            chosenPart(name)
          : `<div class="work-empty"><span class="empty-mark">${icon("lock")}</span><h4>No accounts yet</h4><p>Sign in with a subscription you already have, and ${esc(name)} runs on it.</p></div>` +
            note(`<p>Without an account, ${esc(name)} uses the gateway's default model, ${esc(providerName(DEFAULT_MODEL.provider))} ${esc(DEFAULT_MODEL.model)}, and the gateway picks one of that provider's accounts for each run.</p>`));
      const busy = B.create.status === "creating" || B.create.status === "slow";
      foot = !isAdmin()
        ? adminBar("Creating a bot changes the gateway's settings, which needs admin access. What you chose stays here while you ask.")
        : (B.create.status === "failed" ? note(`<p><b>Could not create the bot.</b> Please try again.</p>`, "danger") : "") +
          (accounts.length || B.create.status !== "idle"
            ? button(busy ? "Creating…" : "Create", `data-b="create" data-size="lg"${busy ? " disabled" : ""}`, "primary")
            : button("Connect an account", 'data-b="connect" data-size="lg"', "primary") + button("Create without an account", 'data-b="create" data-size="lg"', "quiet")) +
          (B.create.status === "slow" ? `<p class="b-hint" role="status" style="text-align:center;margin:0">Still creating. What you entered is kept.</p>` : "");
    } else {
      const view = renderConnect();
      head = `<header class="b-head">${back(view.backLabel, "connect-back")}<h2 id="create-title" tabindex="-1">${view.title}</h2>${close("Close")}</header>`;
      body = view.body;
      foot = view.foot;
    }
    createDialog.innerHTML = `<div class="b-sheet">${head}<div class="b-body">${body}</div>${foot ? `<footer class="b-foot">${foot}</footer>` : ""}</div>`;
    CT.hydrate(createDialog);
  }

  // Under the list: the model and effort once an account is chosen, or what
  // happens with nothing chosen.
  function chosenPart(name) {
    const a = acct(B.draft.account);
    if (!a)
      return note(
        `<p><b>No account chosen.</b> ${esc(name)} would use the gateway's default model, ${esc(providerName(DEFAULT_MODEL.provider))} ${esc(DEFAULT_MODEL.model)}, ` +
          `and the gateway would pick one of ${esc(providerName(DEFAULT_MODEL.provider))}'s accounts for each run.</p>`,
      );
    const [tone] = stateOf(a);
    return (
      `<h4 class="b-group">Model</h4>` +
      `<div class="b-pair">${select("model", "Model", B.draft.model)}${select("effort", "Effort", B.draft.effort)}</div>` +
      `<p class="b-hint">${esc(providerName(a.provider))} models, as the gateway lists them. Change either later in ${esc(name)}'s settings.</p>` +
      (tone === "warn" || tone === "danger"
        ? note(`<p>${esc(acctName(a))} ${a.status === "expiring" ? `expires ${a.expiry}` : "needs signing in again"}. Sign in again before then, or ${esc(name)}'s runs will fail.</p>`, "warn")
        : "")
    );
  }

  const select = (what, label, value) =>
    `<button type="button" class="b-select" data-b-select="${what}" aria-haspopup="menu" aria-expanded="false" aria-label="${label}: ${esc(value || "none")}"${isAdmin() ? "" : " disabled"}>` +
    `<small>${label}</small><span>${esc(value || "—")}</span>${icon("chevron")}</button>`;

  function create() {
    if (!isAdmin()) return;
    const want = p("create");
    B.create.status = "creating";
    renderCreate();
    announce("Creating the bot");
    const slow = setTimeout(() => {
      if (B.create.status === "creating") {
        B.create.status = "slow";
        renderCreate();
      }
    }, want === "slow" ? 300 : 4000);
    setTimeout(
      () => {
        clearTimeout(slow);
        if (want === "failed" || want === "slow") {
          B.create.status = want === "slow" ? "slow" : "failed";
          renderCreate();
          if (want === "failed") announce("Could not create the bot");
          return;
        }
        finishCreate();
      },
      want === "slow" ? 600 : 700,
    );
  }

  function finishCreate() {
    const name = B.draft.name.trim() || "New bot";
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "new-bot";
    while (app.bots.some((b) => b.id === id)) id += "-2";
    CT.botArt[id] = { body: B.draft.body, color: B.draft.color, tilt: 0, look: [0.6, 0] };
    const a = acct(B.draft.account);
    binding[id] = { account: a ? a.id : null, model: a ? B.draft.model : null, effort: B.draft.effort, locked: false, inherits: !a };
    app.bots.push({ id, name, label: "", tasks: [{ id: `${id}-1`, title: "Main", at: 3000, when: "now", preview: "No messages yet.", unread: false, status: "idle", html: "", fresh: true }] });
    B.create = { step: "look", status: "idle", opener: null, created: true };
    B.draft = { name: "", body: "drop", color: "#ff6f9c", account: null, model: null, effort: "Medium" };
    createDialog.close();
    app.selectBot(id);
    $(".composer-input")?.focus();
    announce(`Created ${name}`);
  }

  // Connecting an account: the same component in New bot and in Settings -----------------------------

  function startConnect(from, optionId, stage) {
    B.connect = { from, view: optionId ? "flow" : "providers", option: optionId || null, stage: stage || null, pasted: "", domain: "", label: "", error: "", apikey: { provider: "openai", key: "" } };
  }

  function option() {
    return OPTIONS.find((o) => o.id === B.connect.option);
  }

  function renderConnect() {
    const c = B.connect;
    if (c.view === "providers") return providersView();
    if (c.view === "label") return labelView();
    return flowView();
  }

  function providersView() {
    const row = (o) =>
      `<li><button type="button" class="b-choice" data-b-option="${o.id}"${isAdmin() ? "" : ' aria-disabled="true"'}>` +
      `<span class="b-choice-text"><span class="b-choice-title">${esc(o.label)} <span>· ${esc(o.hint)}</span></span>` +
      `<span class="b-choice-sub">${FLOW_WORDS[o.flow]}</span></span>${icon("chevron")}</button></li>`;
    const has = accounts.some((a) => a.provider === B.connect.apikey.provider && a.kind === "key");
    const body =
      `<p class="b-lead">Sign in with a subscription you already pay for. Your gateway does the sign-in and keeps it; Clawtrate never sees your password and never keeps the sign-in.</p>` +
      `<h4 class="b-group">Subscriptions</h4><ul class="b-choices">${OPTIONS.filter((o) => o.group === "sub").map(row).join("")}</ul>` +
      `<h4 class="b-group">Billed per token</h4><ul class="b-choices">${OPTIONS.filter((o) => o.group === "token").map(row).join("")}</ul>` +
      `<details class="b-disclosure"${p("apikey") === "open" ? " open" : ""}><summary>${icon("chevron")}Use an API key instead</summary><div class="b-disclosure-body">` +
      `<p class="b-hint" style="margin-top:4px">With an API key, the provider bills each request by the tokens it uses, apart from any subscription you have. Most people don't need one.</p>` +
      `<label class="b-field"><span>Provider</span><select class="input" data-b-keyprovider${isAdmin() ? "" : " disabled"}>` +
      KEY_PROVIDERS.map((id) => `<option value="${id}"${id === B.connect.apikey.provider ? " selected" : ""}>${providerName(id)}</option>`).join("") +
      `</select></label>` +
      `<label class="b-field"><span>Key</span><input class="input" type="password" autocomplete="off" spellcheck="false" data-b-key placeholder="Paste the key"${isAdmin() ? "" : " disabled"} /></label>` +
      (has
        ? note(`<p>This replaces the ${esc(providerName(B.connect.apikey.provider))} key your gateway already has. Bots that use it switch to the new key. To keep both, add the second on the gateway's machine.</p>`, "warn")
        : "") +
      `<p class="b-hint">The key goes to your gateway, which keeps it. It is not kept on this device, and Clawtrate can't read it back.</p>` +
      `<div class="b-actions" style="margin-top:12px">${button("Save key", `data-b="save-key" data-size="sm"${isAdmin() ? "" : " disabled"}`)}</div>` +
      `</div></details>`;
    return { title: "Connect an account", backLabel: B.connect.from === "create" ? "Back to accounts" : "Back to accounts", body, foot: isAdmin() ? "" : adminBar("Connecting an account needs admin access. The gateway lets only admin connections start a sign-in.") };
  }

  function flowView() {
    const c = B.connect;
    const o = option();
    const who = providerName(o.provider);
    const title = `Sign in to ${o.label}`;
    const cancel = button("Cancel", 'data-b="cancel-signin"', "quiet");
    const again = button("Start again", 'data-b="restart-signin"');
    const choose = button("Choose another way", 'data-b="to-providers"', "quiet");
    const link = (text) => `${button(`${text} ${icon("external")}`, 'data-b="open-link"')}`;
    let body = "";
    let foot = "";
    const stage = c.stage;
    if (!isAdmin()) {
      return { title, backLabel: "Back to sign-in methods", body: `<p class="b-lead">${FLOW_WORDS[o.flow]}.</p>`, foot: adminBar("Signing in needs admin access. The gateway lets only admin connections start a sign-in.") };
    }
    if (stage === "busy") {
      body = result("warn", "clock", "The gateway is busy", "It is already running a sign-in or a setup, and does one at a time. Try again when that one finishes.");
      foot = button("Try again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "domain") {
      body =
        `<p class="b-lead">Enter your company's GitHub address. The gateway then shows a code to enter there.</p>` +
        `<label class="b-field"><span>GitHub Enterprise address</span><input class="input" data-b-domain data-b-focus placeholder="github.example.com" value="${esc(c.domain)}" /></label>`;
      foot = button("Continue", 'data-b="domain-next" data-size="lg"', "primary") + cancel;
    } else if (stage === "starting") {
      body = `<p class="b-lead">${FLOW_WORDS[o.flow]}.</p>` + wait("Asking the gateway to start the sign-in…");
      foot = cancel;
    } else if (stage === "waiting" && (o.flow === "code" || o.flow === "domain")) {
      body =
        `<ol class="b-steps"><li><p>Open ${esc(who)}'s sign-in page.</p>${link(`Open ${esc(who)}'s page`)}<p class="b-hint" style="margin-top:6px">sign-in.example/device</p></li>` +
        `<li><p>Enter this code there, and approve.</p><div class="b-code"><code aria-label="Code QK4F 7PZD">QK4F-7PZD</code>${copy("code", "QK4F-7PZD")}</div></li></ol>` +
        wait(`Waiting for ${esc(who)}. The code works for 15 minutes.`) +
        `<p class="b-hint">Keep this open until it finishes. Closing Clawtrate or losing the connection to the gateway ends the sign-in.</p>`;
      foot = cancel;
    } else if (stage === "waiting" && o.flow === "paste") {
      body =
        `<ol class="b-steps"><li><p>Open ${esc(who)}'s sign-in page and sign in.</p>${link(`Open ${esc(who)}'s page`)}</li>` +
        `<li><p>The page then shows a code, or your browser lands on an address that does not open. Copy the code, or that whole address, and paste it here.</p>` +
        `<label class="b-field"><span>Code or address</span><input class="input" type="password" autocomplete="off" spellcheck="false" data-b-paste data-b-focus placeholder="Paste here" /></label></li></ol>` +
        `<p class="b-hint">It goes straight to your gateway, which finishes the sign-in. Clawtrate does not keep it.</p>`;
      foot = button("Continue", 'data-b="paste-next" data-size="lg"', "primary") + cancel;
    } else if (stage === "checking") {
      body = wait(`Finishing the sign-in with ${esc(who)}…`);
      foot = cancel;
    } else if (stage === "waiting" && o.flow === "host") {
      const step = "ssh -N -L 8080:127.0.0.1:8080 gateway-host";
      body =
        `<p class="b-lead">This sign-in finishes on the gateway's machine: ${esc(who)} sends your browser back to an address there. The gateway says:</p>` +
        `<ol class="b-steps"><li><p>On a computer that isn't the gateway, forward its port first:</p><div class="command-line"><code>${step}</code>${copy("command", step)}</div></li>` +
        `<li><p>Then open the sign-in page in that computer's browser.</p>${link(`Open ${esc(who)}'s page`)}</li></ol>` +
        wait(`Waiting for ${esc(who)} to send your browser back to the gateway…`);
      foot = cancel + choose;
    } else if (stage === "connected") {
      return labelView();
    } else if (stage === "failed") {
      body = result("danger", "warning", "Couldn't connect", `${esc(who)} refused the sign-in: the code was not accepted. Nothing was saved.`);
      foot = button("Try again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "expired") {
      body = result("warn", "clock", "The sign-in expired", "It wasn't finished in time. Nothing was saved. Start again for a new code.");
      foot = button("Start again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    } else if (stage === "cancelled") {
      body = result("", "x", "Sign-in cancelled", "Nothing was saved.");
      foot = again + choose;
    } else if (stage === "dropped") {
      body = result("warn", "warning", "The sign-in ended", "The connection to the gateway dropped, and a sign-in ends with its connection. Nothing was saved.");
      foot = button("Start again", 'data-b="restart-signin" data-size="lg"', "primary") + choose;
    }
    return { title, backLabel: "Back to sign-in methods", body, foot };
  }

  function labelView() {
    const c = B.connect;
    const provider = c.keyProvider || option().provider;
    const others = accounts.filter((a) => a.provider === provider && a.id !== c.newId);
    const who = providerName(provider);
    const clash = others.find((a) => a.label.trim().toLowerCase() === c.label.trim().toLowerCase() && c.label.trim());
    const locked = Object.entries(binding).filter(([, b]) => b.locked && acct(b.account)?.provider === provider);
    const body =
      result("ok", "check", c.keyProvider ? "Key saved" : `Connected to ${esc(who)}`, c.keyProvider ? `Your gateway keeps the key.` : `Your gateway keeps the sign-in.`).replace(" data-b-focus", "") +
      `<label class="b-field"><span>Label</span><input class="input" data-b-label data-b-focus maxlength="32" placeholder="${others.length ? "For example, Home or Studio" : "For example, Personal"}" value="${esc(c.label)}" aria-describedby="b-label-help" /></label>` +
      (clash
        ? `<p class="b-field-error" id="b-label-help">Another ${esc(who)} account is called ${esc(clash.label)}. Choose a different label.</p>`
        : `<p class="b-hint" id="b-label-help">${others.length ? `You have another ${esc(who)} account, ${esc(acctName(others[0]))}. A label tells them apart everywhere.` : "Shown wherever this account is, so you can tell accounts apart."}</p>`) +
      locked
        .map(([bot]) => {
          const name = app.bots.find((x) => x.id === bot)?.name;
          return note(`<p>Clawtrate checked ${esc(name)}'s lock after this sign-in. It still allows only ${esc(acctName(acct(binding[bot].account)))}.</p>`, "", icon("lock"));
        })
        .join("");
    const foot = button("Done", `data-b="label-done" data-size="lg"${(others.length && !c.label.trim()) || clash ? " disabled" : ""}`, "primary");
    return { title: c.keyProvider ? "API key" : `Sign in to ${option().label}`, backLabel: "Back", body, foot };
  }

  function connectTo(stage) {
    B.connect.stage = stage;
    rerender();
    if (stage === "connected") {
      const o = option();
      const id = `${o.provider}:${["home", "studio", "second", "third"].find((x) => !acct(`${o.provider}:${x}`)) || Date.now()}`;
      accounts.push({ id, provider: o.provider, label: "", kind: o.group === "token" ? "key" : "subscription", how: `${o.label}: ${FLOW_WORDS[o.flow].toLowerCase()}`, status: "ok", fresh: true });
      B.connect.newId = id;
      B.connect.view = "label";
      announce(`Connected to ${providerName(o.provider)}`);
      rerender(true);
    }
  }

  let flowTimer = null;
  function beginSignIn(optionId) {
    clearTimeout(flowTimer);
    B.connect.view = "flow";
    B.connect.option = optionId;
    const o = option();
    B.connect.stage = o.flow === "domain" && !B.connect.domain ? "domain" : "starting";
    rerender(true);
    if (B.connect.stage === "starting") flowTimer = setTimeout(() => connectTo("waiting"), 700);
  }

  // Settings --------------------------------------------------------------------------------------------

  const settingsDialog = $("#settings-dialog");
  const SECTIONS = [["accounts", "Accounts"]];
  CT.botsSections = SECTIONS;

  function openSettings(opener, section) {
    B.settings.opener = opener || document.activeElement;
    if (section) {
      B.settings.section = section;
      B.settings.pane = "section";
    }
    renderSettings();
    if (!settingsDialog.open) settingsDialog.showModal();
    focusFirst(settingsDialog);
  }

  function renderSettings() {
    const s = B.settings;
    const nav =
      `<nav class="b-nav" aria-label="Settings"><h2 id="settings-title">Settings</h2>` +
      SECTIONS.map(([id, label]) => `<button type="button" class="b-nav-item" data-b-section="${id}"${id === s.section ? ' aria-current="page"' : ""}>${label}${icon("chevron")}</button>`).join("") +
      `</nav>`;
    const section = sectionView();
    settingsDialog.innerHTML =
      `<div class="b-settings" data-pane="${s.pane}">${nav}<section class="b-section" aria-labelledby="b-section-title">${close("Close settings")}` +
      `<header class="b-section-head">${section.back || ""}<h3 id="b-section-title" tabindex="-1">${section.title}</h3></header>` +
      `<div class="b-section-body">${section.body}</div>${section.foot ? `<footer class="b-section-foot">${section.foot}</footer>` : ""}</section></div>`;
    CT.hydrate(settingsDialog);
  }

  const toNav = () => back("Back to settings", "to-nav");

  function sectionView() {
    const s = B.settings;
    if (s.section === "accounts") {
      if (B.connect && B.connect.from === "settings") {
        const view = renderConnect();
        return { title: view.title, back: back(view.backLabel, "connect-back"), body: view.body, foot: view.foot };
      }
      if (s.account && acct(s.account)) return accountPage(acct(s.account));
      return accountsList();
    }
    return (CT.botsSectionViews?.[s.section] || (() => ({ title: "", body: "" })))({ back: toNav(), isAdmin, adminBar, button, note, esc, icon });
  }

  function accountsList() {
    const body =
      `<div class="b-headrow"><p class="b-lead" style="margin:0">Your bots run on these. Your gateway signs in and keeps each sign-in; Clawtrate never sees a password or keeps a sign-in.</p>` +
      `${isAdmin() ? button("Connect an account", 'data-b="connect" data-size="sm"') : ""}</div>` +
      (accounts.length
        ? accountGroups({ row: (a) => accountRow(a, { open: true }) })
        : `<div class="work-empty"><span class="empty-mark">${icon("lock")}</span><h4>No accounts yet</h4><p>Connect a subscription you already have, and choose it when you create a bot.</p>` +
          (isAdmin() ? `<div style="margin-top:12px">${button("Connect an account", 'data-b="connect"', "primary")}</div>` : "") +
          `</div>`) +
      (isAdmin() ? "" : `<p class="b-hint">Labels are shown to admin connections only, so accounts are named by provider here.</p>`);
    return { title: "Accounts", back: toNav(), body, foot: isAdmin() ? "" : adminBar("Connecting and changing accounts needs admin access.") };
  }

  function accountPage(a) {
    const users = usedBy(a.id);
    const [tone, word] = stateOf(a);
    const edit = B.settings.edit;
    const lockedBy = users.filter((name) => binding[app.bots.find((x) => x.name === name)?.id]?.locked);
    const labelRow = edit
      ? `<div class="b-row"><dt>Label</dt><dd style="display:flex;gap:6px;align-items:center"><input class="input" style="height:34px;width:150px" data-b-relabel data-b-focus maxlength="32" value="${esc(a.label)}" aria-label="Label" />` +
        `${button("Save", 'data-b="relabel-save" data-size="sm"', "primary")}${button("Cancel", 'data-b="relabel-cancel" data-size="sm"', "quiet")}</dd></div>`
      : `<div class="b-row"><dt>Label</dt><dd>${isAdmin() ? `${esc(a.label || "None")} ${button("Edit", 'data-b="relabel" data-size="sm"', "quiet")}` : "Shown to admin connections"}</dd></div>`;
    const body =
      `<dl class="facts"><div><dt>Provider</dt><dd>${esc(providerName(a.provider))}</dd></div>${labelRow}` +
      `<div><dt>Kind</dt><dd>${kindWord(a)}</dd></div>` +
      `<div><dt>State</dt><dd><span class="b-state"${tone ? ` data-tone="${tone}"` : ' data-tone="ok"'}>${tone ? icon("warning") : icon("check")}${word}${a.expiryDate ? `, ${a.expiryDate}` : ""}</span></dd></div>` +
      `<div><dt>Used by</dt><dd>${users.length ? esc(users.map((n) => (lockedBy.includes(n) ? `${n} (locked)` : n)).join(", ")) : "No bots"}</dd></div>` +
      `<div><dt>On the gateway</dt><dd class="mono">${esc(a.id)}</dd></div></dl>` +
      `<p class="b-hint">${esc(a.how)}. The gateway keeps the sign-in; Clawtrate can't read it.</p>` +
      (isAdmin()
        ? `<div class="b-actions" style="margin-top:18px">${a.kind !== "key" ? button("Sign in again", 'data-b="resign" data-size="sm"', tone ? "primary" : "") : ""}<span class="spacer"></span>` +
          `${button("Disconnect…", 'data-b="disconnect" data-size="sm" data-tone="danger"', "quiet")}</div>`
        : "");
    return { title: acctName(a), back: back("Back to accounts", "to-accounts"), body, foot: isAdmin() ? "" : adminBar("Changing an account needs admin access.") };
  }

  // Confirmation ------------------------------------------------------------------------------------------

  const confirmDialog = $("#confirm-dialog");
  let confirmAction = null;
  function confirmBox({ title, text, action, label, run }) {
    confirmAction = run;
    confirmDialog.innerHTML =
      `<div class="b-confirm"><h2 id="confirm-title">${title}</h2><p id="confirm-text">${text}</p>` +
      `<div class="b-actions">${button("Cancel", 'data-b="confirm-cancel"', "quiet")}${button(label, `data-b="confirm-ok" data-tone="${action}"`)}</div></div>`;
    confirmDialog.showModal();
    $('[data-b="confirm-cancel"]', confirmDialog).focus();
  }

  function disconnect(a) {
    const users = usedBy(a.id);
    confirmBox({
      title: `Disconnect ${acctName(a)}?`,
      text: users.length
        ? `${users.join(" and ")} ${users.length === 1 ? "uses" : "use"} it. ${users.length === 1 ? "It shows" : "They show"} No account until you choose another, and Clawtrate doesn't start ${users.length === 1 ? "it" : "them"} until then. Your gateway removes the sign-in.`
        : "No bot uses it. Your gateway removes the sign-in.",
      action: "danger",
      label: "Disconnect",
      run: () => {
        Object.values(binding).forEach((b) => {
          if (b.account === a.id) {
            b.account = null;
            b.locked = false;
            b.removed = true;
          }
        });
        accounts = accounts.filter((x) => x.id !== a.id);
        B.settings.account = null;
        renderSettings();
        focusFirst(settingsDialog);
        announce(`Disconnected ${acctName(a)}`);
        CT.botsChanged?.();
      },
    });
  }

  // Menus for model and effort ---------------------------------------------------------------------------

  let menu = null;
  function openSelect(buttonEl, items, current, pick) {
    closeSelect();
    menu = document.createElement("ul");
    menu.className = "menu b-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", buttonEl.querySelector("small").textContent);
    menu.innerHTML = items
      .map(([value, sub]) => `<li role="none"><button type="button" class="menu-item" role="menuitemradio" aria-checked="${value === current}" data-value="${esc(value)}">${esc(value)}${sub ? `<small>${esc(sub)}</small>` : ""}</button></li>`)
      .join("");
    buttonEl.closest("dialog, aside").append(menu);
    const r = buttonEl.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(r.left, innerWidth - 220))}px`;
    menu.style.top = `${Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8)}px`;
    menu.style.minWidth = `${Math.max(200, r.width)}px`;
    buttonEl.setAttribute("aria-expanded", "true");
    menu.opener = buttonEl;
    menu.pick = pick;
    ($('[aria-checked="true"]', menu) || $(".menu-item", menu)).focus();
  }
  function closeSelect(refocus) {
    if (!menu) return false;
    menu.opener.setAttribute("aria-expanded", "false");
    if (refocus) menu.opener.focus();
    menu.remove();
    menu = null;
    return true;
  }
  CT.botsSelect = openSelect;

  // Wiring -------------------------------------------------------------------------------------------------

  function focusFirst(dialog) {
    requestAnimationFrame(() => {
      const target = $("[data-b-focus]", dialog) || $("h2[tabindex], h3[tabindex]", dialog);
      target?.focus();
    });
  }

  // Re-render whichever dialog shows the connect component.
  function rerender(focus) {
    CT.botsRender?.();
    if (createDialog.open) {
      renderCreate();
      if (focus) focusFirst(createDialog);
    }
    if (settingsDialog.open) {
      renderSettings();
      if (focus) focusFirst(settingsDialog);
    }
  }

  function requestAdmin() {
    B.req = "asking";
    rerender();
    announce("Asking the gateway");
    setTimeout(() => {
      B.req = "requested";
      rerender();
      announce("Access requested");
    }, 600);
  }

  function grantAdmin() {
    B.access = "admin";
    B.req = "none";
    B.grantedNote = true;
    rerender();
    announce("Admin access granted. You can change settings.");
    CT.botsChanged?.();
    setTimeout(() => {
      B.grantedNote = false;
      rerender();
    }, 4000);
  }

  // New bot from the "+" menu and from ⌘N; Settings from the gateway menu and ⌘,.
  document.addEventListener(
    "click",
    (event) => {
      const t = event.target;
      if (t.closest('[data-action="new-bot"]')) {
        event.stopPropagation();
        $("#rail-menu").hidden = true;
        $("#new-button").setAttribute("aria-expanded", "false");
        openCreate($("#new-button"));
      } else if (t.closest('[data-action="b-settings"]')) {
        event.stopPropagation();
        $("#gateway-menu").hidden = true;
        $$('[data-action="gateway-menu"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
        openSettings($(".gateway-pill"));
      }
    },
    true,
  );

  document.addEventListener("keydown", (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "n" && !createDialog.open && app.model.access === "write") {
      event.preventDefault();
      openCreate(document.activeElement);
    }
    if (mod && event.key === "," && !settingsDialog.open) {
      event.preventDefault();
      openSettings(document.activeElement);
    }
  });

  // Radio groups: one tab stop; arrows move and choose.
  document.addEventListener("keydown", (event) => {
    const radio = event.target.closest?.('[role="radio"]');
    if (radio && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) {
      const group = radio.closest('[role="radiogroup"]');
      if (!group) return;
      event.preventDefault();
      const radios = $$('[role="radio"]', group.closest(".b-body, .b-section-body") || group).filter((r) => r.closest('[role="radiogroup"]')?.getAttribute("aria-labelledby") === group.getAttribute("aria-labelledby") && r.closest('[role="radiogroup"]').getAttribute("aria-label") === group.getAttribute("aria-label"));
      const container = radio.closest("dialog, aside");
      const i = radios.indexOf(radio);
      const n = event.key === "Home" ? 0 : event.key === "End" ? radios.length - 1 : (i + (["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : -1) + radios.length) % radios.length;
      radios[n].click();
      const d = radios[n].dataset;
      const key = d.bBody ? `[data-b-body="${d.bBody}"]` : d.bColor ? `[data-b-color="${d.bColor}"]` : d.bChoose ? `[data-b-choose="${d.bChoose}"]` : `[data-t3="${d.t3}"][data-value="${d.value}"]`;
      $(key, container)?.focus();
    }
    // An open select menu: arrows move, Escape closes it before anything else.
    if (menu && menu.contains(event.target)) {
      const items = $$(".menu-item", menu);
      const i = items.indexOf(event.target);
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const n = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (i + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[n].focus();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeSelect(true);
      }
      if (event.key === "Tab") closeSelect(false);
    }
    if (event.key === "Enter" && event.target.matches?.("#b-name")) {
      event.preventDefault();
      $('[data-b="next"]', createDialog)?.click();
    }
  });

  [createDialog, settingsDialog, confirmDialog].forEach((dialog) =>
    dialog.addEventListener("cancel", (event) => {
      if (menu) {
        event.preventDefault();
        closeSelect(true);
      }
    }),
  );
  createDialog.addEventListener("close", () => {
    clearTimeout(flowTimer);
    if (B.create.step === "connect") B.create.step = "account";
    B.connect = null;
    // After Create the new bot's composer has focus; otherwise focus goes back to the opener.
    if (B.create.created) return void (B.create.created = false);
    const to = B.create.opener && document.contains(B.create.opener) && B.create.opener.offsetParent ? B.create.opener : $("#new-button");
    setTimeout(() => to?.focus?.(), 0);
  });
  settingsDialog.addEventListener("close", () => {
    clearTimeout(flowTimer);
    B.connect = null;
    B.settings.edit = false;
    const to = B.settings.opener && document.contains(B.settings.opener) && B.settings.opener.offsetParent ? B.settings.opener : $(".gateway-pill");
    setTimeout(() => to?.focus?.(), 0);
  });

  document.addEventListener("input", (event) => {
    const t = event.target;
    if (t.id === "b-name") {
      B.draft.name = t.value;
      $(".b-preview", createDialog)?.setAttribute("aria-label", `${t.value || "New bot"}'s picture`);
    }
    if (t.matches("[data-b-label]")) {
      B.connect.label = t.value;
      const pos = t.selectionStart;
      rerender();
      const field = $("[data-b-label]", createDialog.open ? createDialog : settingsDialog);
      field.focus();
      field.setSelectionRange(pos, pos);
    }
    if (t.matches("[data-b-domain]")) B.connect.domain = t.value;
    if (t.matches("[data-b-key]")) B.connect.apikey.key = t.value;
  });
  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-b-keyprovider]")) {
      B.connect.apikey.provider = event.target.value;
      rerender();
      const details = $(".b-disclosure", createDialog.open ? createDialog : settingsDialog);
      if (details) details.open = true;
      $("[data-b-keyprovider]", createDialog.open ? createDialog : settingsDialog)?.focus();
    }
  });

  document.addEventListener("click", (event) => {
    const t = event.target;
    if (menu && !menu.contains(t) && !t.closest("[data-b-select]")) closeSelect(false);
    if (menu && t.closest(".b-menu .menu-item")) {
      const value = t.closest(".menu-item").dataset.value;
      const pick = menu.pick;
      closeSelect(true);
      pick(value);
      return;
    }
    const inDialog = t.closest(".b-dialog");
    const shape = t.closest("[data-b-body]");
    if (shape) {
      B.draft.body = shape.dataset.bBody;
      renderCreate();
      return;
    }
    const color = t.closest("[data-b-color]");
    if (color) {
      B.draft.color = color.dataset.bColor;
      renderCreate();
      return;
    }
    const choose = t.closest("[data-b-choose]");
    if (choose && !choose.closest("aside")) {
      if (!isAdmin()) return;
      B.draft.account = choose.dataset.bChoose;
      const a = acct(B.draft.account);
      if (!MODELS[a.provider].includes(B.draft.model)) B.draft.model = MODELS[a.provider][0];
      renderCreate();
      return;
    }
    const sel = t.closest("[data-b-select]");
    if (sel && inDialog === createDialog) {
      if (menu && menu.opener === sel) return closeSelect(true);
      const a = acct(B.draft.account);
      if (sel.dataset.bSelect === "model")
        openSelect(sel, MODELS[a.provider].map((m) => [m, ""]), B.draft.model, (v) => {
          B.draft.model = v;
          renderCreate();
          $('[data-b-select="model"]', createDialog).focus();
        });
      else
        openSelect(sel, EFFORTS.map((e) => [e, ""]), B.draft.effort, (v) => {
          B.draft.effort = v;
          renderCreate();
          $('[data-b-select="effort"]', createDialog).focus();
        });
      return;
    }
    const opt = t.closest("[data-b-option]");
    if (opt) {
      if (!isAdmin()) return;
      return beginSignIn(opt.dataset.bOption);
    }
    const section = t.closest("[data-b-section]");
    if (section) {
      B.settings.section = section.dataset.bSection;
      B.settings.account = null;
      B.settings.pane = "section";
      B.connect = null;
      renderSettings();
      focusFirst(settingsDialog);
      return;
    }
    const accountLink = t.closest("[data-b-account]");
    if (accountLink) {
      B.settings.account = accountLink.dataset.bAccount;
      B.settings.edit = false;
      renderSettings();
      focusFirst(settingsDialog);
      return;
    }
    const action = t.closest("[data-b]")?.dataset.b;
    if (!action) return;
    const c = B.connect;
    switch (action) {
      case "close":
        t.closest("dialog").close();
        break;
      case "next":
        B.create.step = "account";
        renderCreate();
        focusFirst(createDialog);
        break;
      case "to-look":
        B.create.step = "look";
        renderCreate();
        focusFirst(createDialog);
        break;
      case "create":
        create();
        break;
      case "connect":
        startConnect(inDialog === createDialog ? "create" : "settings");
        if (inDialog === createDialog) B.create.step = "connect";
        rerender(true);
        break;
      case "connect-back":
        clearTimeout(flowTimer);
        if (c && c.view !== "providers" && !(c.view === "label")) {
          B.connect.view = "providers";
          B.connect.stage = null;
        } else {
          B.connect = null;
          if (inDialog === createDialog) B.create.step = "account";
        }
        rerender(true);
        break;
      case "to-providers":
        clearTimeout(flowTimer);
        B.connect.view = "providers";
        B.connect.stage = null;
        rerender(true);
        break;
      case "cancel-signin":
        clearTimeout(flowTimer);
        connectTo("cancelled");
        announce("Sign-in cancelled");
        focusFirst(inDialog);
        break;
      case "restart-signin":
        beginSignIn(c.option);
        break;
      case "domain-next":
        if (!c.domain.trim()) return;
        c.stage = "starting";
        rerender(true);
        flowTimer = setTimeout(() => connectTo("waiting"), 700);
        break;
      case "paste-next": {
        const value = $("[data-b-paste]", inDialog).value.trim();
        if (!value) return;
        c.stage = "checking";
        rerender(true);
        flowTimer = setTimeout(() => connectTo(value === "bad" ? "failed" : "connected"), 800);
        break;
      }
      case "open-link":
        announce("Opened in your browser");
        break;
      case "save-key": {
        const field = $("[data-b-key]", inDialog);
        if (!field.value.trim()) return field.focus();
        const provider = c.apikey.provider;
        let existing = accounts.find((a) => a.provider === provider && a.kind === "key");
        if (!existing) {
          existing = { id: `${provider}:manual`, provider, label: "", kind: "key", how: "API key, entered in Clawtrate", status: "static" };
          accounts.push(existing);
        }
        field.value = "";
        c.keyProvider = provider;
        c.newId = existing.id;
        c.label = existing.label;
        c.view = "label";
        rerender(true);
        announce("Key saved");
        break;
      }
      case "label-done": {
        const a = acct(c.newId);
        a.label = c.label.trim();
        delete a.fresh;
        const from = c.from;
        B.connect = null;
        if (from === "create") {
          B.create.step = "account";
          B.draft.account = a.id;
          B.draft.model = MODELS[a.provider][0];
        }
        rerender(true);
        CT.botsChanged?.();
        break;
      }
      case "to-nav":
        B.settings.pane = "nav";
        B.connect = null;
        renderSettings();
        $(`[data-b-section="${B.settings.section}"]`, settingsDialog)?.focus();
        break;
      case "to-accounts":
        B.settings.account = null;
        renderSettings();
        focusFirst(settingsDialog);
        break;
      case "relabel":
        B.settings.edit = true;
        renderSettings();
        focusFirst(settingsDialog);
        break;
      case "relabel-cancel":
        B.settings.edit = false;
        renderSettings();
        $('[data-b="relabel"]', settingsDialog)?.focus();
        break;
      case "relabel-save": {
        const a = acct(B.settings.account);
        const value = $("[data-b-relabel]", settingsDialog).value.trim();
        if (accounts.some((x) => x !== a && x.provider === a.provider && x.label.toLowerCase() === value.toLowerCase())) {
          $("[data-b-relabel]", settingsDialog).setAttribute("aria-invalid", "true");
          return announce(`Another ${providerName(a.provider)} account is called ${value}`);
        }
        a.label = value;
        B.settings.edit = false;
        renderSettings();
        $('[data-b="relabel"]', settingsDialog)?.focus();
        announce("Label saved");
        CT.botsChanged?.();
        break;
      }
      case "resign": {
        const a = acct(B.settings.account);
        startConnect("settings");
        beginSignIn(OPTIONS.find((o) => o.provider === a.provider).id);
        break;
      }
      case "disconnect":
        disconnect(acct(B.settings.account));
        break;
      case "confirm-cancel":
        confirmDialog.close();
        break;
      case "confirm-ok":
        confirmDialog.close();
        confirmAction?.();
        break;
      case "request":
        requestAdmin();
        break;
      case "request-check":
        grantAdmin();
        break;
      case "request-cancel":
        B.req = "none";
        rerender();
        announce("Request cancelled");
        break;
    }
  });

  // Copy says what happened: a check when the clipboard took it; otherwise the
  // text is selected and the announcer says how to copy it.
  document.addEventListener("click", async (event) => {
    const button = event.target.closest(".b-dialog .copy[data-copy], #work-panel .copy[data-copy]");
    if (!button) return;
    const what = button.dataset.what;
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.dataset.copied = "true";
      announce(`Copied ${what}`);
    } catch {
      const code = button.parentElement.querySelector("code");
      if (code) getSelection().selectAllChildren(code);
      button.dataset.copied = "failed";
      announce("Couldn't copy. The text is selected.");
    }
    setTimeout(() => delete button.dataset.copied, 1400);
  });

  // The countdown on a pending request.
  setInterval(() => {
    if (B.req !== "requested") return;
    B.seconds = B.seconds <= 1 ? 4 : B.seconds - 1;
    $$(".access-wait").forEach((el) => (el.textContent = `checking again in ${B.seconds}s`));
  }, 1000);

  // Prototype controls in the dark bar, for the stages a real provider would cause.
  const extra = $("#proto-extra .run-controls");
  if (extra) {
    extra.insertAdjacentHTML(
      "afterbegin",
      `<button type="button" data-b-proto="approve">Sign-in approved</button><button type="button" data-b-proto="expire">Expire</button>` +
        `<button type="button" data-b-proto="fail">Refuse</button><button type="button" data-b-proto="drop">Drop connection</button>`,
    );
    extra.addEventListener("click", (event) => {
      const what = event.target.closest("[data-b-proto]")?.dataset.bProto;
      if (!what || !B.connect || B.connect.view !== "flow") return;
      clearTimeout(flowTimer);
      connectTo({ approve: "connected", expire: "expired", fail: "failed", drop: "dropped" }[what]);
    });
  }

  // Shared with the later parts of this file.
  Object.assign(CT, { botsData: { B, accounts: () => accounts, binding, MODELS, EFFORTS, PROVIDERS, OPTIONS, acct, acctName, acctTitle, accountRow, accountGroups, providerName, stateOf, usedBy, kindWord, isAdmin, adminBar, button, note, copy, glyph, wait, result, back, close, select, announce, rerender, openSettings, openCreate, startConnect, beginSignIn, renderSettings, focusFirst, openSelect, closeSelect, confirmBox } });

  // First paint from the address --------------------------------------------------------------------------

  // The shell's own question, "may this connection write?", follows the tier.
  if (B.access === "read") {
    app.model.access = "read";
    app.selectBot(app.model.selectedBot);
  }
  if (p("open") === "create") {
    if (B.create.step === "connect") startConnect("create", p("connect"), p("stage"));
    openCreate($("#new-button"));
    if (B.connect?.option && !p("stage")) beginSignIn(B.connect.option);
    if (B.connect?.stage === "connected") connectTo("connected");
  }
  if (p("open") === "settings") {
    if (p("connect") || p("step") === "connect") startConnect("settings", p("connect"), p("stage"));
    openSettings($(".gateway-pill"));
    if (B.connect?.stage === "connected") connectTo("connected");
  }
  window.bots = { B, accounts: () => accounts, binding, openCreate, openSettings, connectTo, grantAdmin };
})();
