// docs/design/drafts-and-vault.md: the draft card (sections 3 to 5), Settings,
// Drafts (6), the masked secret card (7) and Settings, Vault (8, 9). Every
// state can be given in the address (section 14); every path can be clicked to
// its outcome, carrying what the person typed. The prototype bar picks what the
// gateway does next. Draft examples use a proposed plugin (#89) and stand-in
// tools.
(function () {
  const CT = window.CT;
  const P = CT.params;
  const root = document.getElementById("root");
  const live = document.getElementById("d-announce");
  const icon = (name) => CT.icon(name);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${label}</button>`;
  const PROPOSED = "Draft examples use a proposed plugin (#89) and stand-in tools.";

  const S = {
    view: P.get("view") || "draft",
    kind: P.get("kind") || "email",
    d: P.get("d") || "pending",
    s: P.get("s") || "pending",
    v: P.get("v") || "list",
    p: P.get("p") || "running",
    access: P.get("access") || "admin",
    req: P.get("req") || "none",
    pane: "section",
    // What the gateway does next, picked in the prototype bar.
    answer: P.get("answer") || "applied",
    checkfinds: P.get("checkfinds") || "waiting",
    secretsave: P.get("secretsave") || "stored",
    vanswer: P.get("vanswer") || "ack",
    tool: P.get("tool") || "reports",
    hostsrep: P.get("hostsrep") || "available",
    folded: true,
    value: "",
    hosts: ["api.example.com"],
    item: P.get("item") || "STORE_API_KEY",
    vkind: "secret",
    added: false,
    removed: false,
    drafts: { otto: true, pip: true, marlow: true, juniper: false },
    unknownSwitch: null,
    saving: null,
    typed: null, // what the person typed into the draft's fields, carried through both holds
  };
  if (S.s === "hosts") S.hosts = ["api.example.com", "api.example.net"];
  const HOSTS_STATES = { omitted: "omitted", missing: "missing", kindchanged: "kind_changed", hostsunavailable: "unavailable" };
  if (HOSTS_STATES[S.s]) {
    S.hostsrep = HOSTS_STATES[S.s];
    S.s = "saved";
  }
  if (S.s === "saved") S.hostsBack = true;
  const EDIT_STATES = ["editwaiting", "edited", "elsewhere", "editsent", "editdiscarded", "editexpired", "editrestart"];
  if (EDIT_STATES.includes(S.d)) S.edited = true;
  if (S.d === "raw") {
    S.raw = true;
    S.d = "pending";
  }
  if (S.v === "envitem") {
    S.item = "BUILD_REGION";
    S.v = "item";
  }
  if (S.v === "newenv") {
    S.vkind = "env";
    S.v = "new";
  }

  // The data ---------------------------------------------------------------
  const TOOL = { email: "mail_send", slack: "slack_post" };
  const EMAIL = {
    from: "otto@example.com",
    to: ["dana@example.com"],
    cc: ["lee@example.org"],
    subject: "Media box report",
    body:
      "Hi Dana,\n\nThe media box's disk is 91% full. I moved last month's transcode logs to archive/ and attached this week's report.\n\nNothing else needs doing today. I'll check the disk again on Friday and send you the numbers then.\n\nThe largest folders now are:\n- archive/ (412 GB)\n- library/ (1.1 TB)\n- transcode/ (64 GB)\n\nOtto",
    files: [{ name: "report.txt", size: "28 bytes" }],
  };
  const SLACK = { workspace: "Example Co", to: "#ops", thread: "Disk alerts", text: "Media box disk at 91%. Last month's logs are in archive/." };
  // The edit drawn when a state is opened from the address; a walk carries what was typed instead.
  const SAMPLE_EDIT = {
    email: {
      to: ["dana@example.com", "sam@example.net"],
      cc: ["lee@example.org"],
      subject: "Media box report: disk at 91%",
      body: "Hi Dana and Sam,\n\nThe disk is at 91%.  Last month's logs are in archive/.\n\nOtto",
    },
    slack: { to: "#ops", thread: "Disk alerts", text: "Disk at 91% on the media box.\nLogs moved to archive/." },
  };
  const VAULT = [
    { name: "BUILD_REGION", kind: "env", hosts: [], updated: "Nov 3", refs: [] },
    { name: "MEDIA_BOX_TOKEN", kind: "secret", hosts: ["media.example.net"], updated: "Nov 12", refs: [] },
    { name: "STORE_API_KEY", kind: "secret", hosts: ["api.example.com"], updated: "Nov 19", refs: ["plugins.entries.price-tracker.config.apiKey"] },
  ];
  const KIND_WORD = { secret: "Protected", env: "Environment value" };
  const BOTS = [
    ["otto", "Otto"],
    ["pip", "Pip"],
    ["marlow", "Marlow"],
    ["juniper", "Juniper"],
  ];
  const SECRET_TOOL_BOTS = "Otto, Pip and Marlow";
  const EVERY_BOT = "Otto, Pip, Marlow and Juniper";
  const PLAIN = "The gateway keeps this value in its state database on its own machine and doesn't encrypt it there.";
  const ENV_WORDS = "The gateway returns this value to callers that can list it, and supplies it to commands.";

  // State in the address, so every screen can be opened directly -------------
  function sync() {
    const q = new URLSearchParams(location.search);
    const set = (k, v, dflt) => (v === dflt || v === "none" ? q.delete(k) : q.set(k, v));
    set("view", S.view, "draft");
    set("kind", S.kind, "email");
    set("d", S.d, "pending");
    set("s", S.s, "pending");
    set("v", S.v, "list");
    set("p", S.p, "running");
    set("access", S.access, "admin");
    set("req", S.req, "none");
    history.replaceState(null, "", `${location.pathname}?${q}`);
  }
  const say = (text) => {
    live.textContent = "";
    setTimeout(() => (live.textContent = text), 30);
  };
  const go = (patch, words) => {
    Object.assign(S, patch);
    sync();
    render();
    if (words) say(words);
  };
  const later = (fn, ms = 500) => setTimeout(fn, ms);

  // Shared pieces -------------------------------------------------------------
  function accessBar(need, scope) {
    if (S.req === "requested")
      return (
        `<section class="access-bar" role="region" aria-label="Access" data-state="requested"><div class="access-row">${icon("clock")}` +
        `<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span></div>` +
        `<div class="command-line"><code>openclaw devices approve 3f9a2c71</code></div></section>`
      );
    if (S.req === "denied")
      return (
        `<section class="access-bar" role="region" aria-label="Access" data-state="denied"><div class="access-row">${icon("x")}` +
        `<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device keeps the access it had.</span>` +
        button("Request again", 'data-d="request" data-size="sm"') +
        `</div></section>`
      );
    return (
      `<section class="access-bar" role="region" aria-label="Access" data-state="none"><div class="access-row">${icon("eye")}` +
      `<span class="shelf-text"><b>${S.access === "read" ? "Read-only." : "Admin access needed."}</b> ${need}</span>` +
      button(`Request ${scope} access`, 'data-d="request" data-size="sm"', "primary") +
      `</div></section>`
    );
  }
  const PLUGIN_WORDS = {
    running: "Drafts plugin answered at 5:46 PM.",
    unchecked: "Clawtrate couldn't check the drafts plugin. Drafts may be unavailable.",
    absent: "Drafts methods unavailable on this gateway.",
    old: "Clawtrate's drafts plugin is version 0.9; drafts need 1.0 or newer.",
  };
  const pluginMark = () =>
    S.p === "running"
      ? `<span class="d-mark">${icon("plug")}Held by Clawtrate's drafts plugin. It waits up to 10 minutes.</span>`
      : `<span class="d-mark" data-tone="danger">${icon("warning")}${PLUGIN_WORDS[S.p]}</span>`;
  const proposedLine = `<p class="d-proposed" data-testid="proposed">${icon("plug")} ${PROPOSED}</p>`;

  // The draft card ------------------------------------------------------------
  const base = (kind) => (kind === "email" ? EMAIL : SLACK);
  const edit = (kind) => S.typed || SAMPLE_EDIT[kind];
  const editedModel = (kind) => ({ ...base(kind), ...edit(kind) });
  const changedFields = (kind) => {
    const b = base(kind);
    const e = editedModel(kind);
    const pairs =
      kind === "email"
        ? [
            ["To", b.to.join(", ") !== e.to.join(", ")],
            ["Cc", b.cc.join(", ") !== e.cc.join(", ")],
            ["Subject", b.subject !== e.subject],
            ["Body", b.body !== e.body],
          ]
        : [
            ["To", b.to !== e.to],
            ["Thread", b.thread !== e.thread],
            ["Body", b.text !== e.text],
          ];
    return pairs.filter(([, c]) => c).map(([k]) => k);
  };
  const rowsOf = (m, kind, changed = []) => {
    const mark = (k) => (changed.includes(k) ? `<span class="d-changed">Edited</span>` : "");
    const rows =
      kind === "email"
        ? [
            ["From", esc(m.from)],
            ["To", esc(m.to.join(", ")) + mark("To")],
            ["Cc", esc(m.cc.join(", ")) + mark("Cc")],
            ["Subject", esc(m.subject) + mark("Subject")],
          ]
        : [
            ["Workspace", esc(m.workspace)],
            ["To", esc(m.to) + mark("To")],
            ["Thread", esc(m.thread) + mark("Thread")],
          ];
    return `<dl class="d-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  };
  const bodyOf = (m, kind, changed = []) => {
    const text = kind === "email" ? m.body : m.text;
    const long = text.split("\n").length > 8;
    return (
      `<p class="d-body" data-testid="body" data-folded="${long && S.folded}">${esc(text)}${changed.includes("Body") ? `<span class="d-changed">Edited</span>` : ""}</p>` +
      (long ? `<p class="d-sentence"><button type="button" class="link-button" data-d="fold">${S.folded ? "Show more" : "Show less"}</button></p>` : "")
    );
  };
  function filesOf(kind, phase = "first") {
    if (kind !== "email") return "";
    const unchecked = S.d === "unchecked";
    const line = unchecked
      ? "Couldn't check report.txt: it isn't in Otto's workspace. If it changes before it's sent, Clawtrate can't tell."
      : phase === "second"
        ? "Checked after the first answer. The file can still change while this draft waits."
        : "Checked when Otto asked, 5:42 PM. Checked again after your answer.";
    return (
      `<ul class="d-files" aria-label="Attachments">` +
      EMAIL.files
        .map(
          (f) =>
            `<li class="d-file"${unchecked || phase === "second" ? ' data-tone="warn"' : ""}>${icon("file")}<span>${esc(f.name)}</span><span class="d-size">${f.size}</span>` +
            `<span class="d-check">${line}</span></li>`,
        )
        .join("") +
      `</ul>`
    );
  }
  const title = (kind) => (kind === "email" ? "New email" : "Slack message");
  const noun = (kind) => (kind === "email" ? "email" : "message");
  const subline = (kind) =>
    kind === "email"
      ? `Otto wants to send this from its email tool, <code>${TOOL.email}</code>.`
      : `Otto wants to post this with its Slack tool, <code>${TOOL.slack}</code>.`;
  const recipient = (m, kind) => (kind === "email" ? m.to[0] : m.to);
  const rawOf = (kind, edited) =>
    S.raw
      ? `<pre class="d-raw" data-testid="raw">${esc(
          JSON.stringify(
            {
              "plugin.approval.requested": {
                id: edited ? "plugin:5b1e… (the second hold)" : "plugin:9c1e…",
                request: {
                  pluginId: "clawtrate-drafts",
                  title: edited ? "Send the edited draft?" : "Send this draft?",
                  toolName: TOOL[kind],
                  toolCallId: "call_uchl09771ul",
                  agentId: "otto",
                  runId: "7839881d…",
                },
              },
              "the bot's call (tool start)": { name: TOOL[kind], args: kind === "email" ? { to: EMAIL.to, subject: EMAIL.subject, "…": "…" } : { to: SLACK.to, "…": "…" } },
              "clawtrate-drafts.get (proposed)": { phase: edited ? "second" : "first", revision: edited ? 2 : 1 },
            },
            null,
            2,
          ),
        )}</pre>`
      : "";

  function pendingCard(kind) {
    const st = S.d;
    const editedView = ["edited", "elsewhere"].includes(st) || (S.edited && ["sending", "refused", "noanswer", "unknown"].includes(st));
    const m = editedView ? editedModel(kind) : base(kind);
    const changed = editedView ? changedFields(kind) : [];
    const sending = st === "sending";
    const heading = editedView ? (kind === "email" ? "Edited email" : "Edited Slack message") : title(kind);
    const region = `${heading} to ${recipient(m, kind)}. Ready to send.`;
    let decision = "";
    if (sending) decision = `<p class="d-say">${icon("clock")} Sending your decision…</p>`;
    if (st === "refused") decision = `<p class="d-say" data-tone="danger">The gateway refused this decision: approval already being resolved by another request. The draft is still waiting.</p>`;
    if (st === "noanswer") decision = `<p class="d-say" data-tone="warn">No answer from the gateway. Your decision may or may not have been applied.</p>`;
    if (st === "unknown")
      decision = `<p class="d-say" data-tone="warn">Couldn't confirm what happened. The gateway no longer lists this draft, and Otto's ${noun(kind)} tool hasn't reported back.</p>`;
    if (st === "stillwaiting") decision = `<p class="d-say">Your decision wasn't applied. The draft is still waiting.</p>`;
    if (st === "disabled") decision = `<p class="d-say" data-tone="accent">Drafts off for Otto. This draft is still waiting for you.</p>`;
    if (st === "disableunknown")
      decision = `<p class="d-say" data-tone="warn">Couldn't confirm the setting. Read it again. ${button("Read again", 'data-d="disable-read" data-size="sm"')}</p>`;
    if (st === "norecord") decision = `<p class="d-say" data-tone="warn">Couldn't read this draft. The gateway still lists it as waiting.</p>`;
    const matchLine = editedView
      ? `<p class="d-match">${st === "elsewhere" ? "Edited on another device at 5:44 PM." : `You edited Otto's ${noun(kind)}. This is what will be sent.`} <button type="button" class="link-button" data-d="show-original">${S.showOriginal ? "Hide Otto's version" : "Show Otto's version"}</button></p>`
      : "";
    let actions = "";
    if (st === "noanswer" || st === "unknown") actions = button("Check again", 'data-d="check"') + `<span class="spacer"></span>` + button("Discard", 'data-d="discard"', "quiet");
    else if (st === "norecord") actions = button("Check again", 'data-d="check-record"') + `<span class="spacer"></span>` + button("Discard", 'data-d="discard"', "quiet");
    else if (st === "refused") actions = button("Try again", 'data-d="send"', "primary") + `<span class="spacer"></span>` + button("Discard", 'data-d="discard"', "quiet");
    else if (editedView)
      actions =
        button(sending ? "Sending…" : `Send edited ${noun(kind)}`, `data-d="send"${sending ? " disabled" : ""}`, "primary") + `<span class="spacer"></span>` + button("Discard", 'data-d="discard"', "quiet");
    else
      actions =
        button(sending && S.last === "send" ? "Sending…" : kind === "email" ? "Send email" : "Send message", `data-d="send"${sending ? " disabled" : ""}`, "primary") +
        button("Edit", `data-d="edit"${sending ? " disabled" : ""}`) +
        `<span class="spacer"></span>` +
        button("Discard", 'data-d="discard"', "quiet");
    const full =
      st === "full"
        ? `<div class="request-inset d-full"><dl class="d-facts"><dt>Tool</dt><dd><code>${TOOL[kind]}</code></dd><dt>Bot</dt><dd>Otto</dd><dt>Task</dt><dd>Disk almost full on the media box</dd><dt>Asked</dt><dd>5:42 PM, expires 5:52 PM</dd><dt>Held by</dt><dd>Clawtrate's drafts plugin: "Send this draft?"</dd></dl></div>`
        : "";
    const contents = st === "norecord" ? "" : rowsOf(m, kind, changed) + bodyOf(m, kind, changed) + filesOf(kind, editedView ? "second" : "first");
    return (
      `<section class="card request d-card" data-kind="draft" data-state="pending" role="region" aria-label="${esc(region)}" data-testid="draft">` +
      `<header class="request-head"><div><h3 class="request-title">${heading}</h3><p class="d-sub">${subline(kind)}</p>${matchLine}</div><span class="tag" data-tone="warn">Ready to send</span></header>` +
      contents +
      (editedView && S.showOriginal ? originalOf(kind) : "") +
      (st === "edited" ? `<p class="d-hint">The gateway asks again because you edited it. This answer sends it.</p>` : "") +
      decision +
      `<div class="request-actions">${actions}</div>` +
      `<p class="d-sentence"><button type="button" class="link-button" data-d="full">${st === "full" ? "Hide full request" : "Show full request"}</button></p>` +
      full +
      `<div class="d-foot">${pluginMark()}${S.access === "admin" && !editedView ? `<button type="button" class="link-button" data-d="disable">Disable drafts for Otto</button>` : ""}<button type="button" class="link-button" data-d="raw">${S.raw ? "Hide Raw" : "Raw"}</button></div>` +
      rawOf(kind, editedView) +
      `</section>`
    );
  }

  const originalOf = (kind) => `<div class="d-editnote" data-testid="original"><b>Otto's version</b>${rowsOf(base(kind), kind)}${bodyOf(base(kind), kind)}</div>`;

  function editCard(kind) {
    const m = { ...base(kind), ...(S.typed || {}) };
    const st = S.d;
    const busy = st === "editsaving";
    const fields =
      kind === "email"
        ? `<label for="e-to">To</label><input class="input" id="e-to" value="${esc(m.to.join(", "))}" /><label for="e-cc">Cc</label><input class="input" id="e-cc" value="${esc(m.cc.join(", "))}" /><label for="e-subject">Subject</label><input class="input" id="e-subject" value="${esc(m.subject)}" />`
        : `<label for="e-to">To</label><input class="input" id="e-to" value="${esc(m.to)}" /><label for="e-thread">Thread</label><input class="input" id="e-thread" value="${esc(m.thread)}" />`;
    let note = "";
    if (busy) note = `<p class="d-say">${icon("clock")} Giving your edit to the drafts plugin…</p>`;
    if (st === "editfailed") note = `<p class="d-say" data-tone="danger">This draft was already edited on another device.</p>`;
    if (st === "editunconfirmed")
      note = `<p class="d-say" data-tone="warn">Couldn't confirm the edit. Check the draft's current state. ${button("Check the draft", 'data-d="edit-check" data-size="sm"')}</p>`;
    const sendLabel = st === "editunconfirmed" ? "Try again" : `Send edited ${noun(kind)}`;
    return (
      `<section class="card request d-card" data-kind="draft" data-state="editing" role="region" aria-label="${title(kind)}. Editing." data-testid="draft">` +
      `<header class="request-head"><div><h3 class="request-title">${title(kind)}</h3><p class="d-sub">${subline(kind)}</p></div><span class="tag" data-tone="warn">Ready to send</span></header>` +
      `<div class="d-edit">${fields}<textarea id="e-body" aria-label="${kind === "email" ? "Body" : "Message"}">${esc(kind === "email" ? m.body : m.text)}</textarea></div>` +
      (kind === "email" ? `${filesOf(kind)}<p class="d-hint">From and the attachments stay as Otto set them.</p>` : "") +
      `<p class="d-editnote">Your edit goes to Clawtrate's drafts plugin, for this draft only. Sending it releases Otto's ${noun(kind)} to the plugin, which swaps in your edit. The gateway then asks once more, for the edited ${noun(kind)}, and that answer sends it.</p>` +
      note +
      `<div class="request-actions">${button(sendLabel, `data-d="edit-send"${busy || st === "editfailed" ? " disabled" : ""}`, "primary")}${button("Cancel edit", `data-d="edit-cancel"${busy ? " disabled" : ""}`)}<span class="spacer"></span>${button("Discard", 'data-d="discard"', "quiet")}</div>` +
      `<div class="d-foot">${pluginMark()}</div></section>`
    );
  }

  function waitingCard(kind) {
    return (
      `<section class="card request d-card" data-kind="draft" data-state="pending" role="region" aria-label="Edited ${noun(kind)}. Waiting." data-testid="draft">` +
      `<header class="request-head"><div><h3 class="request-title">${kind === "email" ? "Edited email" : "Edited Slack message"}</h3><p class="d-sub">${subline(kind)}</p></div><span class="tag" data-tone="warn">Ready to send</span></header>` +
      rowsOf(editedModel(kind), kind, changedFields(kind)) +
      bodyOf(editedModel(kind), kind, changedFields(kind)) +
      filesOf(kind, "second") +
      `<p class="d-say">${icon("clock")} Waiting for the gateway to ask again for the edited ${noun(kind)}.</p>` +
      `<div class="request-actions"><span class="spacer"></span>${button("Discard", 'data-d="discard"', "quiet")}</div>` +
      `<div class="d-foot">${pluginMark()}</div></section>`
    );
  }

  function resolvedCard(m, kind, tag, tone, sentence, edited = false) {
    const changed = edited ? changedFields(kind) : [];
    return (
      `<section class="card request d-card" data-kind="draft" data-state="resolved" role="region" aria-label="${esc(`${title(kind)} to ${recipient(m, kind)}. ${tag}.`)}" data-testid="draft-resolved">` +
      `<div class="d-resolved"><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${tag}</span><span>${title(kind)} to ${esc(recipient(m, kind))}</span><span class="d-time">5:43 PM</span></div>` +
      `<div style="padding: 0 14px 14px">${rowsOf(m, kind, changed)}${bodyOf(m, kind, changed)}${filesOf(kind, edited ? "second" : "first")}<p class="d-sentence">${sentence}</p>${edited && S.showOriginal ? originalOf(kind) : ""}</div></section>`
    );
  }

  const showOriginalLink = () => `<button type="button" class="link-button" data-d="show-original">${S.showOriginal ? "Hide Otto's version" : "Show Otto's version"}</button>`;

  function sentSentence(m, kind) {
    if (S.d === "sentnoreport" || S.tool === "silent") return `The ${noun(kind)} tool reported success at 5:43 PM. It doesn't say what it sent; this is what you approved.`;
    return kind === "email"
      ? `Sent from ${esc(m.from)} to ${esc(m.to.join(", "))}, cc ${esc(m.cc.join(", "))}, with report.txt (28 bytes), at 5:43 PM. Read back from the email tool's result.`
      : `Posted to ${esc(m.to)} in ${esc(m.workspace)}, in the thread ${esc(m.thread)}, at 5:43 PM. Read back from the message tool's result.`;
  }

  // The bot's own action card for the call: its arguments are the bot's, so the
  // edit is said from the drafts plugin's record (section 4).
  function actionCard(kind) {
    const m = base(kind);
    const line =
      S.p === "running"
        ? `Edited before sending: ${changedFields(kind).join(", ")}. What was sent is on the draft card.`
        : "Clawtrate can't tell whether this was edited: it couldn't read the drafts plugin's record.";
    return (
      `<section class="card d-card" data-kind="action" role="region" aria-label="Otto used ${TOOL[kind]}." data-testid="action">` +
      `<div class="d-resolved"><span class="tag">Done</span><span>Otto used <code>${TOOL[kind]}</code></span><span class="d-time">5:44 PM</span></div>` +
      `<div style="padding: 0 14px 14px"><p class="d-sentence">Otto asked to send to ${esc(kind === "email" ? m.to.join(", ") : m.to)}${kind === "email" ? `, subject "${esc(m.subject)}"` : ""}.</p><p class="d-sentence" data-testid="edit-line">${line}</p></div></section>`
    );
  }

  function finished(kind) {
    const st = S.d;
    const m = S.edited ? editedModel(kind) : base(kind);
    const used = S.edited || S.editGiven ? " Your edit wasn't used." : "";
    if (st === "sent" || st === "sentnoreport") return resolvedCard(m, kind, "Answered", "accent", sentSentence(m, kind));
    if (st === "editsent") return resolvedCard(m, kind, "Answered", "accent", `${sentSentence(m, kind)} You edited this before it was sent. ${showOriginalLink()}`, true);
    if (st === "toolfailed")
      return resolvedCard(m, kind, "Tool failed", "danger", `Tool failed. Sending could not be confirmed. The ${noun(kind)} tool said: account not connected.`, Boolean(S.edited));
    if (st === "discarded") return resolvedCard(base(kind), kind, "Discarded", "", "Discarded at 5:43 PM. Nothing was sent. Otto was told you discarded it.");
    if (st === "editdiscarded") return resolvedCard(m, kind, "Discarded", "", "Discarded at 5:44 PM. Nothing was sent. Your edit wasn't used.", true);
    if (st === "already") return resolvedCard(m, kind, "Discarded", "", "Already answered on another device at 5:25 PM. Your decision was not applied.");
    if (st === "expired") return resolvedCard(base(kind), kind, "Expired", "", `Expired at 5:52 PM without an answer. Nothing was sent.${used}`);
    if (st === "editexpired") return resolvedCard(m, kind, "Expired", "", "Expired at 5:54 PM without an answer. Nothing was sent. Your edit wasn't used.", true);
    if (st === "closed") return resolvedCard(base(kind), kind, "Closed", "", "The run ended before this was answered. Nothing was sent.");
    if (st === "cancelled") return resolvedCard(base(kind), kind, "Cancelled", "", "You stopped the run before answering. Nothing was sent.");
    if (st === "runended") return resolvedCard(m, kind, "Closed", "", `Otto's run ended before this was sent. Nothing was sent from this draft.${used}`, Boolean(S.edited));
    if (st === "editrestart") return resolvedCard(m, kind, "Closed", "", "The gateway restarted before this was sent. Nothing was sent, and your edit wasn't used.", true);
    if (st === "filechanged")
      return resolvedCard(
        base(kind),
        kind,
        "Not sent",
        "danger",
        `report.txt changed after Otto asked (28 bytes then, 44 now), so nothing was sent. Otto was told why. If it asks again, the new draft appears below.${used}`,
      );
    return "";
  }

  function draftCards() {
    const kind = S.kind;
    const st = S.d;
    if (S.access === "read") return accessBar("Request approvals access to see drafts", "approvals");
    if (S.p === "absent" || S.p === "old")
      return `<div class="d-line">${icon("message")} Otto used <code>${TOOL[kind]}</code>. It wasn't held as a draft; its result is on its action card.</div><div class="b-note" data-tone="warn">${icon("warning")}<div><p>${PLUGIN_WORDS[S.p]}</p></div></div>`;
    if (["edit", "editsaving", "editfailed", "editunconfirmed"].includes(st)) return editCard(kind);
    if (st === "editwaiting") return waitingCard(kind);
    const done = finished(kind);
    if (done) return (st === "editsent" ? actionCard(kind) : "") + done;
    return pendingCard(kind);
  }

  function disableDialog() {
    if (S.d !== "disable") return "";
    return (
      `<div class="b-dialog-shim"><dialog class="b-dialog d-dialog" data-kind="confirm" role="alertdialog" open aria-labelledby="dis-title" aria-describedby="dis-text" data-testid="disable-dialog">` +
      `<div class="b-head"><h2 id="dis-title">Send Otto's emails and messages without drafts?</h2></div>` +
      `<div class="b-body"><p id="dis-text">Otto's sends through <code>${TOOL.email}</code> and <code>${TOOL.slack}</code> won't wait for you. They'll go under Otto's rules: <a href="controls.html?bot=otto&amp;panel=open&amp;tab=settings&amp;bview=rules">what Otto may do</a>. The gateway's automatic reviewer covers commands, not sends; a send can still meet an Ask or a Never rule. This is a setting of Clawtrate's drafts plugin; it holds only while the plugin runs.</p></div>` +
      `<div class="b-foot b-actions">${button("Send without drafts", 'data-d="disable-yes"', "primary")}${button("Cancel", 'data-d="disable-no"')}</div></dialog></div>`
    );
  }

  // The masked secret card ------------------------------------------------------
  const HOSTS_LINE = {
    available: (hosts) => `Hosts reported by the bot's tool after saving: ${hosts.length ? hosts.join(", ") : "none"}.`,
    omitted: () => "Current hosts unavailable: the list was too long for the bot's tool to report.",
    missing: () => "Current hosts unavailable: the entry wasn't listed when the bot's tool looked.",
    kind_changed: () => "Current hosts unavailable: the entry is now an environment value.",
    unavailable: () => "Current hosts unavailable.",
  };
  function secretCards() {
    const st = S.s;
    if (S.access === "read") return accessBar("Request questions access to see questions", "questions");
    if (st === "cannotask")
      return (
        `<section class="card d-card" data-kind="action" data-state="failed" role="region" aria-label="Asked for a secret. Failed." data-testid="secret">` +
        `<div class="d-resolved"><span class="tag" data-tone="danger">Failed</span><span>Asked for a secret</span><span class="d-time">5:44 PM</span></div>` +
        `<div style="padding: 0 14px 14px"><p class="d-sentence">missing scope: operator.questions</p>` +
        `<p class="d-sentence">Inferred: the gateway lets a bot ask for a secret only in a run started from a connection with admin access. This device has read, write, approvals and questions.</p></div></section>`
      );
    const name = st === "exists" ? "STORE_API_KEY" : "PRICE_TRACKER_KEY";
    const raw = S.s === "raw" || S.raw;
    const rawBody = raw
      ? `<pre class="d-raw" data-testid="raw">${esc(
          JSON.stringify(
            {
              "question.requested": {
                id: "ask_b2984db4…",
                questions: [{ questionId: "secret_value", isSecret: true, secretStore: { name, kind: "secret", allowedHosts: ["api.example.com"] } }],
              },
              "question.resolve (sent)": { id: "ask_b2984db4…", answers: "(not kept by Clawtrate)", secretStoreAllowedHosts: S.hosts },
              ...(st === "saved" ? { "question.resolve (answer)": { status: "answered", answers: { answers: { secret_value: ["stored"] } } } } : {}),
            },
            null,
            2,
          ),
        )}</pre>`
      : "";
    const resolved = ["saved", "savedrefresh", "already", "skipped", "expired"].includes(st);
    if (resolved) {
      const words = {
        saved: ["Saved", "accent", `Saved to your gateway as ${name}.`],
        savedrefresh: ["Saved", "accent", "Saved to the Vault. The gateway couldn't refresh settings that use it."],
        already: ["Answered", "", "Already answered on another device. Nothing was sent from here."],
        skipped: ["Skipped", "", "Skipped. Otto was told no secret arrived."],
        expired: ["Expired", "", "Expired without an answer. Otto was told no secret arrived."],
      }[st];
      return (
        `<section class="card request d-card" data-kind="secret" data-state="resolved" role="region" aria-label="Otto asks for a secret: ${name}. ${words[0]}." data-testid="secret">` +
        `<header class="request-head"><div><h3 class="request-title">Otto asks for a secret</h3></div><span class="tag"${words[1] ? ` data-tone="${words[1]}"` : ""}>${words[0]}</span></header>` +
        `<dl class="d-rows"><dt>Name</dt><dd><code>${name}</code></dd></dl>` +
        `<p class="d-sentence">${words[2]}</p>` +
        (st === "saved" && S.hostsBack ? `<p class="d-sentence" data-testid="hosts-back">${HOSTS_LINE[S.hostsrep](S.hosts)}</p>` : "") +
        `<div class="d-foot"><button type="button" class="link-button" data-d="raw">${raw ? "Hide Raw" : "Raw"}</button></div>${rawBody}</section>`
      );
    }
    const saving = st === "saving";
    let note = "";
    if (st === "refused") note = `<p class="d-say" data-tone="danger">The gateway didn't save it: the name must use uppercase letters, digits and _. Type it again to try again.</p>`;
    if (st === "unconfirmed") note = `<p class="d-say" data-tone="warn">Couldn't confirm whether the gateway saved it.</p>`;
    const hosts =
      `<span class="d-fieldlabel" id="hosts-label">Allowed hosts</span><div class="d-hosts" role="group" aria-labelledby="hosts-label">` +
      S.hosts.map((h) => `<span class="d-chip">${esc(h)}<button type="button" aria-label="Remove ${esc(h)}" data-host="${esc(h)}">${icon("x")}</button></span>`).join("") +
      `<input class="input" id="add-host" placeholder="Add a host" aria-label="Add a host" />` +
      `</div><p class="d-hint">${
        S.hosts.length
          ? "When the gateway's egress proxy is enabled, it can substitute the value in supported requests to these hosts. Settings can use the reference separately."
          : "No hosts: the egress proxy won't substitute this value in any request. Settings can still use the reference."
      }</p>`;
    const field =
      st !== "unconfirmed"
        ? `<label class="d-fieldlabel" for="secret-value">Secret value</label><div class="d-secure"><input class="input" id="secret-value" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste or type the value" aria-describedby="secret-plain" ${saving ? "disabled" : ""} value="" />` +
          button("Show", 'data-d="reveal" data-size="sm"') +
          `</div><p class="d-hint" id="secret-plain">${PLAIN}</p><details class="d-help"><summary class="link-button">About filling this field</summary><p class="d-hint">Clawtrate's field is its own. Electron, the framework it is built on, documents no password-manager or system fill for an app's fields, and doesn't run browser extensions such as password managers. Copy the value from your password manager and paste it.</p></details>`
        : "";
    const actions =
      st === "unconfirmed"
        ? button("Check", 'data-d="s-check"', "primary")
        : button(saving ? "Saving…" : "Save to the gateway", `data-d="s-save"${saving || !S.value ? " disabled" : ""}`, "primary") +
          `<span class="spacer"></span>` +
          button("Skip", `data-d="s-skip"${saving ? " disabled" : ""}`, "quiet");
    return (
      `<section class="card request d-card" data-kind="secret" data-state="pending" role="region" aria-label="Otto asks for a secret: ${name}." data-testid="secret">` +
      `<header class="request-head"><div><h3 class="request-title">Otto asks for a secret</h3></div><span class="tag">Secret</span></header>` +
      `<dl class="d-rows"><dt>Name</dt><dd><code>${name}</code></dd><dt>Why</dt><dd>"To read prices from the store's API for your tracker."</dd></dl>` +
      `<p class="d-sentence">Saving sends the value to the gateway's store. The answer the bot gets contains a reference and status. ${st === "exists" ? "This replaces the value saved as STORE_API_KEY on Nov 19." : "Saving replaces any value already stored under this name."}</p>` +
      hosts +
      field +
      note +
      `<div class="request-actions">${actions}</div>` +
      `<div class="d-foot"><button type="button" class="link-button" data-d="raw">${raw ? "Hide Raw" : "Raw"}</button></div>${rawBody}</section>`
    );
  }

  // The conversation view -------------------------------------------------------
  function conversation() {
    const secret = S.view === "secret";
    const ask = secret
      ? "Set up the price tracker with the store's API."
      : S.kind === "email"
        ? "Send Dana this week's media box report, with the report attached."
        : "Post the disk alert in #ops, in the disk alerts thread.";
    const reply = secret ? "I need the store's API key to do that." : S.kind === "email" ? "Here's the email. It's waiting for you." : "Here's the message. It's waiting for you.";
    const cards = secret ? secretCards() : draftCards();
    const read = S.access === "read";
    const pending =
      !read &&
      ((secret && ["pending", "typed", "hosts", "exists", "saving", "refused", "unconfirmed", "raw"].includes(S.s)) ||
        (!secret && ["running", "unchecked"].includes(S.p) && !finished(S.kind)));
    const shelf = pending
      ? `<div class="composer-shelf"><div class="shelf-row" data-tone="warn">${icon("approval")}<span class="shelf-text">${secret ? "Otto asked you for a secret" : `Otto has a draft waiting for you`}</span><span class="spacer"></span>${button("Review", 'data-d="review" data-size="sm"')}</div></div>`
      : "";
    return (
      `<div class="d-page" data-view="${S.view}">` +
      `<header class="d-head"><span class="avatar" data-bot="otto" style="--size: 26px; width: 26px; height: 26px"></span><h1>Disk almost full on the media box</h1><span class="d-where">Otto</span></header>` +
      `<div class="d-scroll"><div class="d-transcript" id="transcript">` +
      (secret ? "" : proposedLine) +
      `<div class="msg" data-role="user"><div class="bubble">${esc(ask)}</div></div>` +
      `<div class="msg" data-role="assistant"><div class="bubble">${esc(reply)}</div></div>` +
      cards +
      `</div></div><footer class="d-composer">${shelf}</footer>${disableDialog()}</div>`
    );
  }

  // Settings ------------------------------------------------------------------
  const NAV = [
    ["Gateway", "bots.html?open=settings"],
    ["Accounts", "bots.html?open=settings&section=accounts"],
    ["Integrations", "bots.html?open=settings&section=integrations"],
    ["Permissions", "controls.html?open=settings&section=permissions&part=rules"],
    ["Memory", "controls.html?open=settings&section=memory"],
    ["Usage", "controls.html?open=settings&section=usage"],
    ["Machines", "controls.html?open=settings&section=machines"],
  ];
  function settings(sectionHtml, titleText) {
    const nav =
      `<nav class="b-nav" aria-label="Settings"><div class="b-nav-head"><h2>Settings</h2></div>` +
      NAV.map(([t, href]) => `<a class="b-nav-item" href="${href}">${t}</a>`).join("") +
      `<button type="button" class="b-nav-item" data-d="nav-drafts"${S.view === "drafts" ? ' aria-current="page"' : ""}>${icon("approval")}Drafts</button>` +
      `<button type="button" class="b-nav-item" data-d="nav-vault"${S.view === "vault" ? ' aria-current="page"' : ""}>${icon("lock")}Vault</button></nav>`;
    return (
      `<div class="d-page" data-view="${S.view}"><div class="b-settings d-settings" data-pane="${S.pane}">${nav}` +
      `<section class="b-section" aria-labelledby="section-title"><header class="b-section-head">` +
      `<button type="button" class="icon-button b-back" data-d="to-nav" aria-label="Back to Settings">${icon("back")}</button>` +
      `<h3 id="section-title" tabindex="-1">${titleText}</h3></header><div class="b-section-body">${sectionHtml}</div></section></div>${vaultDialog()}</div>`
    );
  }

  function draftsSection() {
    const running = S.p === "running";
    const admin = S.access === "admin";
    let html = proposedLine;
    html += `<p class="d-mark"${running ? "" : ' data-tone="danger"'}>${icon(running ? "plug" : "warning")}${PLUGIN_WORDS[S.p]}</p>`;
    html += `<div class="b-note">${icon("approval")}<div><p>When a bot sends an email or a message through one of these tools, Clawtrate's drafts plugin holds it here until you send or discard it. It holds only while the plugin runs. Without drafts, a bot's sends go under its rules; the gateway's automatic reviewer covers commands, not sends.</p></div></div>`;
    if (!admin && running) html += accessBar("Changing drafts needs admin access.", "admin");
    if (S.p !== "absent") {
      html += `<h4 class="d-group">Bots</h4>`;
      html += BOTS.map(([id, name]) => {
        const unknown = S.unknownSwitch === id || !running;
        const saving = S.saving === id;
        return (
          `<div class="d-botrow"><span class="avatar" data-bot="${id}"></span><span class="d-botname">${name}</span>` +
          (saving ? `<span class="d-saving">Saving…</span>` : "") +
          (S.unknownSwitch === id ? `<span class="d-saving">Couldn't confirm the setting. Read it again.</span>${button("Read again", `data-read="${id}" data-size="sm"`)}` : "") +
          (unknown
            ? `<span class="d-saving" data-testid="switch-unknown">Unknown</span>`
            : `<button type="button" class="b-switch" role="switch" aria-checked="${S.drafts[id]}" aria-label="Drafts for ${name}" data-bot-switch="${id}"${!admin || saving ? " disabled" : ""}></button>`) +
          `</div>`
        );
      }).join("");
    }
    html += `<h4 class="d-group">Sending tools</h4>`;
    html += `<div class="d-toolrow"><code>${TOOL.email}</code><br />To from <code>to</code>, Cc from <code>cc</code>, Subject from <code>subject</code>, Body from <code>body</code>, files from <code>attachments</code>, From from <code>from</code>.</div>`;
    html += `<div class="d-toolrow"><code>${TOOL.slack}</code><br />Workspace from <code>workspace</code>, To from <code>to</code>, Thread from <code>thread</code>, Body from <code>text</code>.</div>`;
    html += `<div class="d-toolrow"><code>message</code><br />Destination as given, from <code>target</code>, <code>targets</code>, <code>accountId</code>, <code>replyTo</code> and <code>threadId</code>; Clawtrate can't name it. Body from <code>message</code>.</div>`;
    html += `<p class="d-hint">A tool not on this list never makes a draft; its calls follow the bot's rules.</p>`;
    return settings(html, "Drafts");
  }

  const vaultEntries = () => {
    let list = VAULT.slice();
    if (S.added)
      list = list
        .concat([{ name: S.newName || "PRICE_TRACKER_KEY", kind: S.vkind, hosts: S.vkind === "env" ? [] : ["api.example.com"], updated: "Nov 19", refs: [] }])
        .sort((a, b) => a.name.localeCompare(b.name));
    if (S.removed) list = list.filter((e) => e.name !== S.item);
    return list;
  };

  function vaultSection() {
    if (S.access !== "admin") return settings(accessBar("Seeing the Vault needs admin access. The gateway shows its secret store to admin connections only.", "admin"), "Vault");
    const v = S.v;
    if (["item", "remove", "removing", "replace", "stilllisted", "removeunknown"].includes(v)) return settings(itemPage(), "Vault");
    let html = `<div class="b-note">${icon("lock")}<div><p>Values this gateway keeps for its bots and settings. Protected values are never listed. Environment values are returned to callers that can list them, and supplied to commands.</p></div></div>`;
    html += `<div class="d-vhead">${button("New item", 'data-d="v-new"')}</div>`;
    const nm = S.newName || "PRICE_TRACKER_KEY";
    const said = {
      saved: ["accent", "Saved in the Vault."],
      savedrefresh: ["accent", "Saved in the Vault. The gateway couldn't refresh settings that use it."],
      listedonly: ["warn", "This name and its settings are listed. Clawtrate couldn't confirm which value was saved."],
      notlisted: ["warn", "Couldn't confirm the save. The name isn't listed."],
      removed: ["accent", "Removed from the Vault."],
      removedrefresh: ["accent", "Removed from the Vault. The gateway couldn't refresh settings that used it."],
    }[v];
    if (said) html += `<p class="d-say" data-tone="${said[0]}">${said[1]}${["saved", "savedrefresh", "listedonly"].includes(v) ? ` <code>${esc(nm)}</code>` : ""}</p>`;
    if (v === "loading") html += `<div class="d-vlist" aria-busy="true"><div class="d-skel"></div><div class="d-skel"></div><div class="d-skel"></div></div>`;
    else if (v === "error") html += `<div class="b-note" data-tone="danger">${icon("warning")}<div><p>Couldn't read the Vault.</p><div class="b-actions">${button("Try again", 'data-d="v-retry" data-size="sm"')}</div></div></div>`;
    else if (v === "empty") html += `<p class="d-hint">No secrets yet. A bot can ask for one in a conversation, or add one here.</p>`;
    else
      html +=
        `<ul class="d-vlist">` +
        vaultEntries()
          .map(
            (e) =>
              `<li><button type="button" class="d-vrow" data-item="${e.name}"><span class="d-vname">${e.name}</span>` +
              `<span class="d-vmeta">${KIND_WORD[e.kind]}${e.kind === "secret" ? ` · ${e.hosts.length ? e.hosts.join(", ") : "No hosts"}` : ""} · Updated ${e.updated}</span>${icon("chevron")}</button></li>`,
          )
          .join("") +
        `</ul>`;
    html +=
      `<section class="d-sources"><h4>Where a bot's secrets come from</h4>` +
      `<p>This Vault: values the gateway keeps. Protected values aren't listed to bots or to Clawtrate.</p>` +
      `<p>A password manager the gateway offers a bot, such as its 1Password plugin: the value is given to the bot, which can see it.</p>` +
      `<p>Asking you: the bot asks in the conversation, and you type it into Clawtrate's field. It's saved here.</p>` +
      `<p>Nothing on the gateway makes a bot try these in an order. Each bot chooses which to use.</p></section>`;
    return settings(html, "Vault");
  }

  function itemPage() {
    const e = VAULT.find((x) => x.name === S.item) || VAULT[2];
    let html = `<p class="d-sentence"><button type="button" class="link-button" data-d="v-back">${icon("back")} All secrets</button></p>`;
    html += `<h4 class="d-group"><code>${e.name}</code></h4>`;
    html +=
      `<dl class="d-facts"><dt>Name</dt><dd><code>${e.name}</code></dd><dt>Kind</dt><dd>${KIND_WORD[e.kind]}</dd>` +
      (e.kind === "secret" ? `<dt>Allowed hosts</dt><dd>${e.hosts.length ? e.hosts.join(", ") : "No hosts"}</dd>` : "") +
      `<dt>Updated</dt><dd>${e.updated}</dd><dt>Reference</dt><dd><code>store · default · ${e.name}</code></dd></dl>`;
    html += `<p class="d-sentence">${PLAIN}</p>`;
    if (e.kind === "env") html += `<p class="d-say" data-tone="warn">${ENV_WORDS} Clawtrate does not show it.</p>`;
    html +=
      `<div class="b-note">${icon("eye")}<div><p><b>How it can be used.</b> Settings can use this value through its reference. When the gateway's egress proxy is enabled, it can substitute the value in supported requests to these hosts from commands on the gateway's machine. Any bot offered the Secrets tool sees its name and hosts and can remove it. The gateway doesn't limit an item to chosen bots.</p>` +
      `<p class="b-faint">Offered the Secrets tool: ${SECRET_TOOL_BOTS}, as each was last offered, Nov 19.</p></div></div>`;
    if (S.v === "stilllisted") html += `<p class="d-say" data-tone="danger">The gateway answered, but ${e.name} is still listed. ${button("Try again", 'data-d="v-remove-yes" data-size="sm"')}</p>`;
    if (S.v === "removeunknown") html += `<p class="d-say" data-tone="warn">Couldn't confirm the removal. The Vault couldn't be read. ${button("Check", 'data-d="v-remove-check" data-size="sm"')}</p>`;
    html += `<div class="b-actions" style="margin-top: 16px">${button("Replace…", 'data-d="v-replace"')}${button("Remove…", 'data-d="v-remove" data-tone="danger"', "quiet")}</div>`;
    return html;
  }

  function vaultDialog() {
    const v = S.v;
    if (S.view !== "vault") return "";
    if (["new", "replace", "failed", "vsaving"].includes(v)) {
      const replace = v === "replace" || (["vsaving", "failed"].includes(v) && S.replacing);
      const entry = replace ? VAULT.find((x) => x.name === S.item) || VAULT[2] : null;
      const kind = entry ? entry.kind : S.vkind;
      const name = replace ? S.item : S.newName || "";
      const fieldLabel = kind === "env" ? "Environment value" : "Secret value";
      return (
        `<div class="b-dialog-shim"><dialog class="b-dialog d-dialog" open aria-labelledby="new-title" data-testid="vault-dialog">` +
        `<div class="b-head"><h2 id="new-title">${replace ? `Replace ${S.item}` : "New item"}</h2></div><div class="b-body d-dialog-body">` +
        `<label class="d-fieldlabel" for="v-name">Name</label><input class="input" id="v-name" value="${esc(name)}" ${replace ? "readonly" : ""} placeholder="PRICE_TRACKER_KEY" aria-describedby="v-name-hint" />` +
        `<p class="d-hint" id="v-name-hint">Uppercase letters, digits and _.</p>` +
        (S.badName ? `<p class="d-error">Use letters, digits and _</p>` : "") +
        (replace ? `<p class="d-say" data-tone="warn">${S.item} exists. Saving replaces its value${kind === "secret" ? " and hosts" : ""}.</p>` : "") +
        `<span class="d-fieldlabel">Kind</span><div class="d-kind" role="radiogroup" aria-label="Kind"><label><input type="radio" name="v-kind" value="secret" ${kind === "secret" ? "checked" : ""} ${replace ? "disabled" : ""} /> Protected</label><label><input type="radio" name="v-kind" value="env" ${kind === "env" ? "checked" : ""} ${replace ? "disabled" : ""} /> Environment value</label></div>` +
        `<label class="d-fieldlabel" for="secret-value">${fieldLabel}</label><div class="d-secure"><input class="input" id="secret-value" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste or type the value" aria-describedby="v-plain" /></div>` +
        `<p class="d-hint" id="v-plain">${PLAIN}${kind === "env" ? ` ${ENV_WORDS}` : ""}</p>` +
        (kind === "secret" ? `<span class="d-fieldlabel">Allowed hosts</span><div class="d-hosts"><span class="d-chip">api.example.com</span></div>` : "") +
        (v === "failed" ? `<p class="d-say" data-tone="danger">Couldn't save: the name must use uppercase letters, digits and _. Type the value again.</p>` : "") +
        `</div><div class="b-foot b-actions">${button(v === "vsaving" ? "Saving…" : "Save", `data-d="v-save"${v === "vsaving" ? " disabled" : ""}`, "primary")}${button("Cancel", 'data-d="v-cancel"')}</div></dialog></div>`
      );
    }
    if (v === "remove" || v === "removing") {
      const e = VAULT.find((x) => x.name === S.item) || VAULT[2];
      return (
        `<div class="b-dialog-shim"><dialog class="b-dialog d-dialog" data-kind="confirm" role="alertdialog" open aria-labelledby="rm-title" aria-describedby="rm-text" data-testid="remove-dialog">` +
        `<div class="b-head"><h2 id="rm-title">Remove ${e.name}?</h2></div>` +
        `<div class="b-body"><p id="rm-text">Every bot on this gateway loses it: ${EVERY_BOT}. ${e.refs.length ? `These settings refer to this name: <code>${e.refs.join(", ")}</code>. A running process may still have the value.` : "No setting refers to this name."} Removal leaves the value in the database. The gateway's cleanup can purge the deleted row after 30 days.</p></div>` +
        `<div class="b-foot b-actions">${button(v === "removing" ? "Removing…" : "Remove", `data-d="v-remove-yes" data-tone="danger"${v === "removing" ? " disabled" : ""}`, "primary")}${button("Cancel", 'data-d="v-remove-no"')}</div></dialog></div>`
      );
    }
    return "";
  }

  // Render and events -----------------------------------------------------------
  function render() {
    if (S.view === "vault") root.innerHTML = vaultSection();
    else if (S.view === "drafts") root.innerHTML = draftsSection();
    else root.innerHTML = conversation();
    CT.hydrate(root);
    const field = document.getElementById("secret-value");
    if (field && S.view === "secret") {
      field.addEventListener("input", () => {
        S.value = field.value;
        const button = root.querySelector('[data-d="s-save"]');
        if (button) button.disabled = !S.value;
      });
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && S.value) save();
        if (e.key === "Escape") {
          field.value = "";
          S.value = "";
        }
      });
    }
    root.querySelectorAll('input[name="v-kind"]').forEach((r) =>
      r.addEventListener("change", () => {
        const n = document.getElementById("v-name");
        S.newName = n ? n.value : S.newName;
        go({ vkind: r.value });
      }),
    );
    const add = document.getElementById("add-host");
    if (add)
      add.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && add.value.trim()) {
          S.hosts = S.hosts.concat([add.value.trim()]);
          go({ s: S.s === "pending" ? "hosts" : S.s });
        }
      });
  }

  function clearSecret() {
    S.value = "";
    const f = document.getElementById("secret-value");
    if (f) f.value = "";
  }

  function readTyped() {
    const v = (id) => document.getElementById(id)?.value ?? "";
    if (S.kind === "email")
      return {
        to: v("e-to")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        cc: v("e-cc")
          .split(",")
          .map((x) => x.trim())
          .filter(Boolean),
        subject: v("e-subject"),
        body: v("e-body"),
      };
    return { to: v("e-to"), thread: v("e-thread"), text: v("e-body") };
  }

  function secondHold() {
    go({ d: "editwaiting" });
    later(() => go({ d: "edited" }, "The gateway asks again, for the edited version"), 500);
  }

  function decide(which) {
    S.last = which;
    const firstOfEdited = S.d === "elsewhere";
    go({ d: "sending" });
    later(() => {
      const a = S.answer;
      if (a === "refused") return go({ d: "refused" }, "The gateway refused this decision");
      if (a === "already") return go({ d: "already" }, "Already answered on another device");
      if (a === "noanswer") return go({ d: "noanswer" }, "No answer from the gateway");
      if (which === "discard") return go({ d: S.edited || S.editGiven ? "editdiscarded" : "discarded" }, "Discarded");
      if (firstOfEdited) return secondHold();
      if (S.file === "changed") return go({ d: "filechanged" }, "Not sent");
      if (S.tool === "fails") return go({ d: "toolfailed" }, "Tool failed");
      go({ d: S.edited ? "editsent" : S.tool === "silent" ? "sentnoreport" : "sent" }, "Sent");
    });
  }

  function save() {
    go({ s: "saving" });
    later(() => {
      clearSecret();
      const a = S.secretsave;
      if (S.answer === "already") return go({ s: "already" });
      if (a === "refresh") return go({ s: "savedrefresh" }, "Saved to the gateway");
      if (a === "notstored") return go({ s: "refused" }, "Couldn't save");
      if (a === "unclear" || a === "unclear-pending") return go({ s: "unconfirmed" }, "Couldn't confirm the save");
      S.hostsBack = false;
      go({ s: "saved" }, "Saved to the gateway");
      later(() => go({ hostsBack: true }), 400);
    });
  }

  root.addEventListener("click", (event) => {
    const host = event.target.closest("[data-host]");
    if (host) {
      S.hosts = S.hosts.filter((h) => h !== host.dataset.host);
      return go({ s: S.s === "pending" ? "hosts" : S.s });
    }
    if (event.target.closest("[data-read]")) return go({ unknownSwitch: null }, "Setting read");
    const sw = event.target.closest("[data-bot-switch]");
    if (sw && !sw.disabled) {
      const id = sw.dataset.botSwitch;
      go({ saving: id });
      return later(() => {
        if (S.answer === "refused" || S.answer === "noanswer") return go({ saving: null, unknownSwitch: id }, "Couldn't confirm the setting");
        S.drafts[id] = !S.drafts[id];
        go({ saving: null }, `Drafts ${S.drafts[id] ? "on" : "off"} for ${BOTS.find((b) => b[0] === id)[1]}.`);
      });
    }
    const row = event.target.closest("[data-item]");
    if (row) return go({ v: "item", item: row.dataset.item, removed: false });
    const el = event.target.closest("[data-d]");
    if (!el || el.disabled) return;
    const act = el.dataset.d;
    switch (act) {
      case "send":
        return decide("send");
      case "discard":
        return decide("discard");
      case "check": {
        const f = S.checkfinds;
        if (f === "waiting") return go({ d: S.edited ? "edited" : "stillwaiting" }, "Still waiting");
        if (f === "expired") return go({ d: S.edited ? "editexpired" : "expired" });
        if (f === "refused") return go({ d: "refused" });
        if (f === "unknown") return go({ d: "unknown" });
        return go({ d: S.edited ? "editsent" : "sent" }, "Sent");
      }
      case "check-record":
        return go({ d: "pending" });
      case "fold":
        return go({ folded: !S.folded });
      case "full":
        return go({ d: S.d === "full" ? "pending" : "full" });
      case "raw":
        return go({ raw: !(S.raw || S.s === "raw"), s: S.s === "raw" ? "pending" : S.s });
      case "review": {
        const card = root.querySelector('[data-testid="draft"], [data-testid="secret"]');
        if (card) {
          card.setAttribute("tabindex", "-1");
          card.focus();
        }
        return;
      }
      case "edit":
        return go({ d: "edit" });
      case "edit-cancel":
        return go({ d: "pending", typed: null });
      case "edit-check":
        return go({ d: "edit" }, "The draft is still waiting");
      case "edit-send":
        S.typed = readTyped();
        go({ d: "editsaving" });
        return later(() => {
          if (S.answer === "already") return go({ d: "editfailed" }, "Your edit wasn't taken");
          if (S.answer === "refused" || S.answer === "noanswer") return go({ d: "editunconfirmed" }, "Couldn't confirm the edit");
          S.editGiven = true;
          S.last = "send";
          go({ d: "sending" }, "Edit taken");
          later(() => {
            if (S.file === "changed") return go({ d: "filechanged" }, "Not sent");
            S.edited = true;
            secondHold();
          }, 500);
        });
      case "show-original":
        return go({ showOriginal: !S.showOriginal });
      case "disable":
        return go({ d: "disable" });
      case "disable-no":
        return go({ d: "pending" });
      case "disable-yes":
        return later(() => {
          if (S.answer === "refused" || S.answer === "noanswer") return go({ d: "disableunknown" }, "Couldn't confirm the setting");
          S.drafts.otto = false;
          go({ d: "disabled" }, "Drafts off for Otto.");
        }, 300);
      case "disable-read":
        return go({ d: "disabled" }, "Drafts off for Otto.");
      case "request":
        return go({ req: "requested" });
      case "s-save":
        return save();
      case "s-skip":
        clearSecret();
        return go({ s: "skipped" }, "Skipped");
      case "s-check":
        return S.secretsave === "unclear-pending" ? go({ s: "pending" }, "The question is still waiting") : go({ s: "saved", hostsBack: true }, "Saved to the gateway");
      case "reveal": {
        const f = document.getElementById("secret-value");
        if (f) {
          f.type = "text";
          const hide = () => (f.type = "password");
          f.addEventListener("keydown", hide, { once: true });
          f.addEventListener("blur", hide, { once: true });
        }
        return;
      }
      case "nav-drafts":
        return go({ view: "drafts", pane: "section" });
      case "nav-vault":
        return go({ view: "vault", pane: "section", v: "list" });
      case "to-nav":
        return go({ pane: "nav" });
      case "v-new":
        return go({ v: "new", replacing: false, vkind: "secret" });
      case "v-cancel":
        return go({ v: S.replacing ? "item" : "list", badName: false });
      case "v-replace":
        return go({ v: "replace", replacing: true });
      case "v-save": {
        const nameField = document.getElementById("v-name");
        const name = nameField ? nameField.value.trim() : "";
        if (!S.replacing && !/^[A-Z][A-Z0-9_]*$/.test(name)) return go({ badName: true, newName: name });
        const f = document.getElementById("secret-value");
        if (f) f.value = "";
        go({ v: "vsaving", newName: S.replacing ? S.item : name, badName: false });
        return later(() => {
          const a = S.vanswer;
          if (a === "refused") return go({ v: "failed" }, "Couldn't save");
          if (a === "lostnot") return go({ v: "notlisted" }, "Couldn't confirm the save");
          if (a === "lostlisted") return go({ v: "listedonly", added: !S.replacing }, "Listed; the value isn't confirmed");
          if (a === "refresh") return go({ v: "savedrefresh", added: !S.replacing }, "Saved");
          go({ v: "saved", added: !S.replacing }, "Saved");
        });
      }
      case "v-back":
      case "v-retry":
        return go({ v: "list" });
      case "v-remove":
        return go({ v: "remove" });
      case "v-remove-no":
        return go({ v: "item" });
      case "v-remove-yes":
        go({ v: "removing" });
        return later(() => {
          const a = S.vanswer;
          if (a === "lostlisted") return go({ v: "stilllisted" });
          if (a === "lostnot" || a === "refused") return go({ v: "removeunknown" });
          if (a === "refresh") return go({ v: "removedrefresh", removed: true }, "Removed from the Vault");
          go({ v: "removed", removed: true }, "Removed from the Vault");
        });
      case "v-remove-check":
        return go({ v: "removed", removed: true }, "Removed from the Vault");
    }
  });

  root.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      const card = e.target.closest(".d-card");
      const send = card && card.querySelector('[data-d="send"]:not([disabled])');
      if (send) {
        e.preventDefault();
        decide("send");
      }
    }
  });

  // The prototype bar: what the gateway does next, and events ------------------
  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    const sel = (label, key, options) =>
      `<label class="proto-seg">${label} <select data-proto="${key}">${options.map(([v, t]) => `<option value="${v}"${S[key] === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>`;
    extra.innerHTML =
      sel("Gateway answers", "answer", [
        ["applied", "Applied"],
        ["refused", "Refused"],
        ["already", "Already answered"],
        ["noanswer", "No answer"],
      ]) +
      sel("After no answer, Check finds", "checkfinds", [
        ["waiting", "Still waiting"],
        ["expired", "Expired"],
        ["refused", "Refused"],
        ["unknown", "Unknown"],
        ["confirmed", "Sent"],
      ]) +
      sel("Secret save", "secretsave", [
        ["stored", "Stored"],
        ["refresh", "Stored, refresh failed"],
        ["notstored", "Not stored"],
        ["unclear", "Unclear, then answered"],
        ["unclear-pending", "Unclear, then pending"],
      ]) +
      sel("Vault", "vanswer", [
        ["ack", "Acknowledged"],
        ["refresh", "Saved, refresh failed"],
        ["lostlisted", "Lost answer, listed"],
        ["lostnot", "Lost answer, not listed"],
        ["refused", "Refused"],
      ]) +
      sel("Tool result", "tool", [
        ["reports", "Reports what it sent"],
        ["silent", "Says nothing"],
        ["fails", "Fails"],
      ]) +
      sel("Hosts reported", "hostsrep", [
        ["available", "Available"],
        ["omitted", "Omitted"],
        ["missing", "Missing"],
        ["kind_changed", "Kind changed"],
        ["unavailable", "Unavailable"],
      ]) +
      `<button type="button" data-proto-event="file">Change report.txt</button>` +
      `<button type="button" data-proto-event="expire">Expire</button>` +
      `<button type="button" data-proto-event="close">Run ends</button>` +
      `<button type="button" data-proto-event="restart">Restart</button>` +
      `<button type="button" data-proto-event="stop">Stop</button>`;
    extra.addEventListener("change", (e) => {
      const s = e.target.closest("[data-proto]");
      if (s) S[s.dataset.proto] = s.value;
    });
    extra.addEventListener("click", (e) => {
      const b = e.target.closest("[data-proto-event]");
      if (!b) return;
      const ev = b.dataset.protoEvent;
      if (ev === "file") return go({ file: "changed" }, "report.txt changed on the gateway's machine");
      if (S.view === "secret") return go({ s: ev === "expire" ? "expired" : "skipped" });
      if (ev === "restart") return S.edited || S.editGiven || S.d === "edit" ? go({ d: "editrestart", edited: true }) : undefined;
      if (ev === "expire") return go({ d: S.edited ? "editexpired" : "expired" });
      return go({ d: S.edited || S.editGiven ? "runended" : ev === "close" ? "closed" : "cancelled" });
    });
  });

  render();
  if (S.view === "secret" && S.s === "typed") {
    const f = document.getElementById("secret-value");
    if (f) {
      f.value = "example-secret-value";
      S.value = f.value;
      const s = root.querySelector('[data-d="s-save"]');
      if (s) s.disabled = false;
    }
  }
})();
