// docs/design/drafts-and-vault.md: the draft card (sections 3 to 5), Settings,
// Drafts (6), the masked secret card (7) and Settings, Vault (8, 9). Every
// state can be given in the address (section 14); every path can be clicked to
// its outcome. The prototype bar picks what the gateway answers next.
(function () {
  const CT = window.CT;
  const P = CT.params;
  const root = document.getElementById("root");
  const live = document.getElementById("d-announce");
  const icon = (name) => CT.icon(name);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const button = (label, attrs = "", variant = "") =>
    `<button type="button" class="button"${variant ? ` data-variant="${variant}"` : ""} ${attrs}>${label}</button>`;

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
    answer: P.get("answer") || "applied",
    vanswer: P.get("vanswer") || "confirmed",
    tool: P.get("tool") || "reports",
    newcall: P.get("newcall") || "matches",
    folded: true,
    value: "",
    hosts: ["api.example.com"],
    item: P.get("item") || "STORE_API_KEY",
    added: false,
    removed: false,
    drafts: { otto: true, pip: true, marlow: true, juniper: false },
    saving: null,
  };
  if (S.s === "hosts") S.hosts = ["api.example.com", "api.example.net"];
  if (S.d === "differs") S.newcall = "differs";
  if (["editsent", "match", "differs"].includes(S.d)) S.fromEdit = true;

  // The data ---------------------------------------------------------------
  const TOOL = { email: "mail_send", slack: "message" };
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
  const EDITED = {
    email: { ...EMAIL, subject: "Media box report: disk at 91%", body: "Hi Dana,\n\nThe disk is at 91%. Last month's logs are in archive/, and the report is attached.\n\nOtto" },
    slack: { ...SLACK, text: "Disk at 91% on the media box. Logs moved to archive/." },
  };
  const BOT_RETYPED = {
    email: { ...EDITED.email, body: "Hi Dana,\n\nThe disk is at 91%. I moved the logs to archive/. Report attached.\n\nOtto" },
    slack: { ...EDITED.slack, text: "Disk at 91%. Logs moved to archive/." },
  };
  const VAULT = [
    { name: "BUILD_REGION", kind: "Readable by bots", hosts: [], updated: "Nov 3", refs: [] },
    { name: "MEDIA_BOX_TOKEN", kind: "Protected", hosts: ["media.example.net"], updated: "Nov 12", refs: [] },
    { name: "STORE_API_KEY", kind: "Protected", hosts: ["api.example.com"], updated: "Nov 19", refs: ["plugins.entries.price-tracker.config.apiKey"] },
  ];
  const BOTS = [
    ["otto", "Otto"],
    ["pip", "Pip"],
    ["marlow", "Marlow"],
    ["juniper", "Juniper"],
  ];
  const SECRET_TOOL_BOTS = "Otto, Pip and Marlow";
  const EVERY_BOT = "Otto, Pip, Marlow and Juniper";

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
  function accessBar(need) {
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
    const scope = need.startsWith("Seeing the Vault") || need.startsWith("Changing") ? "admin" : need.includes("questions") ? "questions" : "approvals";
    return (
      `<section class="access-bar" role="region" aria-label="Access" data-state="none"><div class="access-row">${icon("eye")}` +
      `<span class="shelf-text"><b>${S.access === "read" ? "Read-only." : "Admin access needed."}</b> ${need}</span>` +
      button(`Request ${scope} access`, 'data-d="request" data-size="sm"', "primary") +
      `</div></section>`
    );
  }
  const pluginWords = {
    running: "Drafts plugin answered at 5:46 PM.",
    stopped: "Clawtrate's drafts plugin isn't answering.",
    absent: "Drafts methods unavailable on this gateway.",
  };
  const notRunningNote = `<div class="b-note" data-tone="danger">${icon("warning")}<div><p>Clawtrate's drafts plugin isn't answering, so nothing waits as a draft. Otto, Pip and Marlow send as their rules allow.</p></div></div>`;
  const pluginMark = () =>
    S.p === "running"
      ? `<span class="d-mark">${icon("plug")}Held by Clawtrate's drafts plugin. It waits up to 10 minutes.</span>`
      : `<span class="d-mark" data-tone="danger">${icon("warning")}Not held now: the drafts plugin isn't running</span>`;

  // The draft card ------------------------------------------------------------
  const rowsOf = (m, kind, changed = []) => {
    const mark = (k) => (changed.includes(k) ? `<span class="d-changed">Changed</span>` : "");
    const rows =
      kind === "email"
        ? [
            ["From", esc(m.from)],
            ["To", esc(m.to.join(", "))],
            ["Cc", esc(m.cc.join(", "))],
            ["Subject", esc(m.subject) + mark("Subject")],
          ]
        : [
            ["Workspace", esc(m.workspace)],
            ["To", esc(m.to)],
            ["Thread", esc(m.thread)],
          ];
    return `<dl class="d-rows">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>`;
  };
  const bodyOf = (m, kind, changed = []) => {
    const text = kind === "email" ? m.body : m.text;
    const long = text.split("\n").length > 8;
    return (
      `<p class="d-body" data-folded="${long && S.folded}">${esc(text)}${changed.includes("Body") ? `<span class="d-changed">Changed</span>` : ""}</p>` +
      (long ? `<p class="d-sentence"><button type="button" class="link-button" data-d="fold">${S.folded ? "Show more" : "Show less"}</button></p>` : "")
    );
  };
  const filesOf = (m, kind) => {
    if (kind !== "email") return "";
    const unchecked = S.d === "unchecked";
    return (
      `<ul class="d-files" aria-label="Attachments">` +
      m.files
        .map(
          (f) =>
            `<li class="d-file"${unchecked ? ' data-tone="warn"' : ""}>${icon("file")}<span>${esc(f.name)}</span><span class="d-size">${f.size}</span>` +
            `<span class="d-check">${unchecked ? "Couldn't check report.txt: it isn't in Otto's workspace. If it changes before it's sent, Clawtrate can't tell." : "Checked when Otto asked, 5:42 PM. Checked again before it's sent."}</span></li>`,
        )
        .join("") +
      `</ul>`
    );
  };
  const title = (kind) => (kind === "email" ? "New email" : "Slack message");
  const sendLabel = (kind) => (kind === "email" ? "Send email" : "Send message");
  const subline = (kind) =>
    kind === "email"
      ? `Otto wants to send this from its email tool, <code>${TOOL.email}</code>.`
      : "Otto wants to post this through its Slack channel, with the message tool.";
  const recipient = (m, kind) => (kind === "email" ? m.to[0] : m.to);

  function pendingCard(m, kind, { fresh = false, match = null } = {}) {
    const st = S.d;
    const sending = st === "sending" || st === "discarding";
    const answering = S.access !== "read";
    const region = `${title(kind)} to ${recipient(m, kind)}. Ready to send.`;
    let decision = "";
    if (sending) decision = `<p class="d-say">${icon("clock")} Sending your decision…</p>`;
    if (st === "refused")
      decision = `<p class="d-say" data-tone="danger">The gateway refused this decision: approval already being resolved by another request. The draft is still waiting.</p>`;
    if (st === "noanswer")
      decision = `<p class="d-say" data-tone="warn">No answer from the gateway. Your decision may or may not have been applied.</p>`;
    if (st === "disabled") decision = `<p class="d-say" data-tone="accent">Drafts off for Otto. This draft is still waiting for you.</p>`;
    if (st === "disablefailed") decision = `<p class="d-say" data-tone="danger">Couldn't save. Drafts are still on for Otto.</p>`;
    if (st === "editfailed") decision = `<p class="d-say" data-tone="danger">This request is still waiting, so your version wasn't sent to Otto.</p>`;
    const matchLine = match
      ? match.same
        ? `<p class="d-match">Matches the version you sent at 5:44 PM.</p>`
        : `<p class="d-match" data-tone="warn">Differs from the version you sent at 5:44 PM: ${match.fields.join(", ")}. <button type="button" class="link-button" data-d="show-mine">Show what you sent</button></p>`
      : "";
    let actions = "";
    if (answering) {
      if (st === "noanswer") actions = button("Check again", 'data-d="check"') + `<span class="spacer"></span>` + button("Discard", 'data-d="discard"', "quiet");
      else if (st === "refused" || st === "editfailed")
        actions = button("Try again", `data-d="${st === "editfailed" ? "edit-send" : "send"}"`, "primary") + `<span class="spacer"></span>` + button("Discard", 'data-d="discard"', "quiet");
      else
        actions =
          button(sending && S.last === "send" ? "Sending…" : sendLabel(kind), `data-d="send"${sending ? " disabled" : ""}`, "primary") +
          button("Edit", `data-d="edit"${sending ? " disabled" : ""}`) +
          `<span class="spacer"></span>` +
          button("Discard", 'data-d="discard"', "quiet");
    }
    const full =
      st === "full"
        ? `<div class="request-inset d-full"><dl class="d-facts"><dt>Tool</dt><dd><code>${TOOL[kind]}</code></dd><dt>Bot</dt><dd>Otto</dd><dt>Task</dt><dd>Disk almost full on the media box</dd><dt>Asked</dt><dd>5:42 PM, expires 5:52 PM</dd><dt>Held by</dt><dd>Clawtrate's drafts plugin: "Send this draft?"</dd></dl></div>`
        : "";
    return (
      `<section class="card request d-card" data-kind="draft" data-state="pending" role="region" aria-label="${esc(region)}" data-testid="${fresh ? "draft-new" : "draft"}">` +
      `<header class="request-head"><div><h3 class="request-title">${title(kind)}</h3><p class="d-sub">${subline(kind)}</p>${matchLine}</div><span class="tag" data-tone="warn">Ready to send</span></header>` +
      rowsOf(m, kind, match && !match.same ? match.fields : []) +
      bodyOf(m, kind, match && !match.same ? match.fields : []) +
      filesOf(m, kind) +
      (S.showMine && match && !match.same ? `<div class="d-editnote"><b>What you sent at 5:44 PM</b>${bodyOf(EDITED[kind], kind)}</div>` : "") +
      decision +
      (answering ? `<div class="request-actions">${actions}</div>` : accessBar("Answering needs approvals access.")) +
      `<p class="d-sentence"><button type="button" class="link-button" data-d="full">${st === "full" ? "Hide full request" : "Show full request"}</button></p>` +
      full +
      `<div class="d-foot">${pluginMark()}${answering && S.access === "admin" ? `<button type="button" class="link-button" data-d="disable">Disable drafts for Otto</button>` : ""}<button type="button" class="link-button" data-d="raw">Raw</button></div>` +
      `</section>`
    );
  }

  function editCard(kind) {
    const m = kind === "email" ? EMAIL : SLACK;
    const fields =
      kind === "email"
        ? `<label for="e-to">To</label><input class="input" id="e-to" value="${esc(m.to.join(", "))}" /><label for="e-cc">Cc</label><input class="input" id="e-cc" value="${esc(m.cc.join(", "))}" /><label for="e-subject">Subject</label><input class="input" id="e-subject" value="${esc(m.subject)}" />`
        : `<label for="e-to">To</label><input class="input" id="e-to" value="${esc(m.to)}" /><label for="e-thread">Thread</label><input class="input" id="e-thread" value="${esc(m.thread)}" />`;
    return (
      `<section class="card request d-card" data-kind="draft" data-state="editing" role="region" aria-label="${title(kind)}. Editing." data-testid="draft">` +
      `<header class="request-head"><div><h3 class="request-title">${title(kind)}</h3><p class="d-sub">${subline(kind)}</p></div><span class="tag" data-tone="warn">Ready to send</span></header>` +
      `<div class="d-edit">${fields}<textarea id="e-body" aria-label="${kind === "email" ? "Body" : "Message"}">${esc(kind === "email" ? m.body : m.text)}</textarea></div>` +
      `<p class="d-editnote">Edits can't be added to a waiting request. Sending your version discards this one and asks Otto to send yours instead. Otto's new ${kind === "email" ? "email" : "message"} will wait here for you again.</p>` +
      `<div class="request-actions">${button("Send your version to Otto", 'data-d="edit-send"', "primary")}${button("Cancel edit", 'data-d="edit-cancel"')}<span class="spacer"></span>${button("Discard", 'data-d="discard"', "quiet")}</div>` +
      `<div class="d-foot">${pluginMark()}</div></section>`
    );
  }

  function resolvedCard(m, kind, tag, tone, sentence) {
    return (
      `<section class="card request d-card" data-kind="draft" data-state="resolved" role="region" aria-label="${esc(`${title(kind)} to ${recipient(m, kind)}. ${tag}.`)}" data-testid="draft-resolved">` +
      `<div class="d-resolved"><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${tag}</span><span>${title(kind)} to ${esc(recipient(m, kind))}</span><span class="d-time">5:43 PM</span></div>` +
      `<div style="padding: 0 14px 14px">${rowsOf(m, kind)}${bodyOf(m, kind)}${filesOf(m, kind)}<p class="d-sentence">${sentence}</p></div></section>`
    );
  }

  function sentSentence(m, kind) {
    if (S.d === "sentnoreport")
      return kind === "email"
        ? "The email tool reported it sent this at 5:43 PM. It doesn't say what it sent; this is what you approved."
        : "The message tool reported it posted this at 5:43 PM. It doesn't say what it posted; this is what you approved.";
    return kind === "email"
      ? `Sent from ${m.from} to ${m.to.join(", ")}, cc ${m.cc.join(", ")}, with report.txt (28 bytes), at 5:43 PM. Read back from the email tool's result.`
      : `Posted to ${m.to} in ${m.workspace}, in the thread ${m.thread}, at 5:43 PM. Read back from the message tool's result.`;
  }

  function draftCards() {
    const kind = S.kind;
    const m = kind === "email" ? EMAIL : SLACK;
    const st = S.d;
    if (S.p !== "running")
      return (
        `<div class="d-line">${icon("message")} Otto used <code>${TOOL[kind]}</code>. It wasn't held as a draft; its result is on its action card.</div>` + notRunningNote
      );
    const editedNew = ["match", "differs", "editsent"].includes(st) || (S.fromEdit && ["sending", "sent", "sentnoreport", "failed", "discarded", "refused", "noanswer", "already"].includes(st));
    if (editedNew) {
      const old = resolvedCard(m, kind, "Discarded", "", "Discarded: you sent your own version to Otto at 5:44 PM.");
      const yours = EDITED[kind];
      const msg =
        `<div class="msg" data-role="user"><div class="bubble" data-testid="edit-message">Please send this instead:<br />` +
        (kind === "email"
          ? `To: ${esc(yours.to.join(", "))}<br />Cc: ${esc(yours.cc.join(", "))}<br />Subject: ${esc(yours.subject)}<br /><br />${esc(yours.body).replace(/\n/g, "<br />")}`
          : `To: ${esc(yours.to)}<br />Thread: ${esc(yours.thread)}<br /><br />${esc(yours.text)}`) +
        `</div></div>`;
      if (st === "editsent") return old + msg + `<p class="d-line">Otto is working on your message.</p>`;
      const nm = S.newcall === "differs" ? BOT_RETYPED[kind] : EDITED[kind];
      const match = S.newcall === "differs" ? { same: false, fields: ["Body"] } : { same: true };
      const next = ["match", "differs"].includes(st) || ["sending", "refused", "noanswer"].includes(st) ? pendingCard(nm, kind, { fresh: true, match }) : finished(nm, kind);
      return old + msg + next;
    }
    if (["edit"].includes(st)) return editCard(kind);
    const done = finished(m, kind);
    return done || pendingCard(m, kind);
  }

  function finished(m, kind) {
    const st = S.d;
    if (st === "sent" || st === "sentnoreport") return resolvedCard(m, kind, "Answered", "accent", sentSentence(m, kind));
    if (st === "failed")
      return resolvedCard(m, kind, "Not sent", "danger", `The ${kind === "email" ? "email" : "message"} tool failed: account not connected. Nothing in its result says it was sent.`);
    if (st === "discarded") return resolvedCard(m, kind, "Discarded", "", "Discarded at 5:43 PM. Nothing was sent. Otto was told you discarded it.");
    if (st === "already") return resolvedCard(m, kind, "Discarded", "", "Already answered on another device at 5:25 PM. Your decision was not applied.");
    if (st === "expired") return resolvedCard(m, kind, "Expired", "", "Expired at 5:52 PM without an answer. Nothing was sent.");
    if (st === "closed") return resolvedCard(m, kind, "Closed", "", "The run ended before this was answered. Nothing was sent.");
    if (st === "cancelled") return resolvedCard(m, kind, "Cancelled", "", "You stopped the run before answering. Nothing was sent.");
    if (st === "filechanged")
      return resolvedCard(
        m,
        kind,
        "Not sent",
        "danger",
        "report.txt changed after Otto asked (28 bytes then, 44 now), so nothing was sent. Otto was told why. If it asks again, the new draft appears below.",
      );
    return "";
  }

  function disableDialog() {
    if (S.d !== "disable") return "";
    return (
      `<div class="b-dialog-shim"><dialog class="b-dialog d-dialog" data-kind="confirm" role="alertdialog" open aria-labelledby="dis-title" aria-describedby="dis-text" data-testid="disable-dialog">` +
      `<div class="b-head"><h2 id="dis-title">Send Otto's emails and messages without drafts?</h2></div>` +
      `<div class="b-body"><p id="dis-text">Otto's sends through <code>${TOOL.email}</code> and the message tool won't wait for you. They'll run as Otto's rules allow: <a href="controls.html?bot=otto&amp;panel=open&amp;tab=settings&amp;bview=rules">what Otto may do</a>. This is a setting of Clawtrate's drafts plugin; it holds only while the plugin runs.</p></div>` +
      `<div class="b-foot b-actions">${button("Send without drafts", 'data-d="disable-yes"', "primary")}${button("Cancel", 'data-d="disable-no"')}</div></dialog></div>`
    );
  }

  // The masked secret card ------------------------------------------------------
  function secretCards() {
    const st = S.s;
    if (st === "cannotask")
      return (
        `<section class="card d-card" data-kind="action" data-state="failed" role="region" aria-label="Asked for a secret. Failed." data-testid="secret">` +
        `<div class="d-resolved"><span class="tag" data-tone="danger">Failed</span><span>Asked for a secret</span><span class="d-time">5:44 PM</span></div>` +
        `<div style="padding: 0 14px 14px"><p class="d-sentence">missing scope: operator.questions</p>` +
        `<p class="d-sentence">Inferred: the gateway lets a bot ask for a secret only in a run started from a connection with admin access. This device has read, write, approvals and questions.</p></div></section>`
      );
    const name = S.s === "exists" ? "STORE_API_KEY" : "PRICE_TRACKER_KEY";
    const answering = S.access !== "read";
    const resolved = ["saved", "already", "skipped", "expired"].includes(st);
    if (resolved) {
      const words = {
        saved: ["Saved", "accent", `Saved securely to your gateway as ${name} at 5:44 PM. Otto can't read it back.`],
        already: ["Answered", "", "Already answered on another device. Nothing was sent from here."],
        skipped: ["Skipped", "", "Skipped. Otto was told no secret arrived."],
        expired: ["Expired", "", "Expired without an answer. Otto was told no secret arrived."],
      }[st];
      return (
        `<section class="card request d-card" data-kind="secret" data-state="resolved" role="region" aria-label="Otto asks for a secret: ${name}. ${words[0]}." data-testid="secret">` +
        `<header class="request-head"><div><h3 class="request-title">Otto asks for a secret</h3></div><span class="tag"${words[1] ? ` data-tone="${words[1]}"` : ""}>${words[0]}</span></header>` +
        `<dl class="d-rows"><dt>Name</dt><dd><code>${name}</code></dd></dl>` +
        `<p class="d-sentence">${words[2]}</p>` +
        (st === "saved" && S.hostsBack !== false ? `<p class="d-sentence" data-testid="hosts-back">Allowed hosts now: ${S.hosts.length ? S.hosts.join(", ") : "none"}.</p>` : "") +
        `<div class="d-foot"><button type="button" class="link-button" data-d="raw">Raw</button></div></section>`
      );
    }
    const saving = st === "saving";
    let note = "";
    if (st === "refused") note = `<p class="d-say" data-tone="danger">The gateway didn't save it: the secret store is busy. Type it again to retry.</p>`;
    if (st === "noanswer")
      note = `<p class="d-say" data-tone="warn">No answer from the gateway. The secret may or may not have been saved.</p>`;
    const hosts =
      `<span class="d-fieldlabel" id="hosts-label">Allowed hosts</span><div class="d-hosts" role="group" aria-labelledby="hosts-label">` +
      S.hosts.map((h) => `<span class="d-chip">${esc(h)}${answering ? `<button type="button" aria-label="Remove ${esc(h)}" data-host="${esc(h)}">${icon("x")}</button>` : ""}</span>`).join("") +
      (answering ? `<input class="input" id="add-host" placeholder="Add a host" aria-label="Add a host" />` : "") +
      `</div><p class="d-hint">${S.hosts.length ? "The egress proxy sends this secret only to these hosts." : "No hosts: the egress proxy won't send this secret anywhere. Settings that refer to it can still use it."}</p>`;
    const field =
      answering && st !== "noanswer"
        ? `<label class="d-fieldlabel" for="secret-value">Secret value</label><div class="d-secure"><input class="input" id="secret-value" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste or type the value" aria-describedby="secret-foot" ${saving ? "disabled" : ""} value="" />` +
          button("Show", 'data-d="reveal" data-size="sm"') +
          `</div><details class="d-help"><summary class="link-button">About filling this field</summary><p class="d-hint">Clawtrate's field is its own. Electron, the framework it is built on, documents no password-manager or system fill for an app's fields, and doesn't run browser extensions such as password managers. Copy the value from your password manager and paste it.</p></details>`
        : "";
    let actions = "";
    if (answering) {
      if (st === "noanswer") actions = button("Check", 'data-d="s-check"', "primary");
      else
        actions =
          button(saving ? "Saving…" : "Save securely", `data-d="s-save"${saving || !S.value ? " disabled" : ""}`, "primary") +
          `<span class="spacer"></span>` +
          button("Skip", `data-d="s-skip"${saving ? " disabled" : ""}`, "quiet");
    }
    return (
      `<section class="card request d-card" data-kind="secret" data-state="pending" role="region" aria-label="Otto asks for a secret: ${name}." data-testid="secret">` +
      `<header class="request-head"><div><h3 class="request-title">Otto asks for a secret</h3></div><span class="tag">Secret</span></header>` +
      `<dl class="d-rows"><dt>Name</dt><dd><code>${name}</code></dd><dt>Why</dt><dd>"To read prices from the store's API for your tracker."</dd></dl>` +
      `<p class="d-sentence">It will be saved to your gateway's shared secret store.${S.s === "exists" ? " This replaces the value saved as STORE_API_KEY on Nov 19." : ""}</p>` +
      hosts +
      field +
      note +
      (answering ? `<div class="request-actions">${actions}</div>` : accessBar("Answering needs questions access.")) +
      `<p class="d-hint" id="secret-foot">Never shown to Otto, and not kept by Clawtrate. Bots on this gateway see its name and hosts, not its value.</p>` +
      `<div class="d-foot"><button type="button" class="link-button" data-d="raw">Raw</button></div></section>`
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
    const pending =
      (secret && ["pending", "typed", "hosts", "exists", "saving", "refused", "noanswer"].includes(S.s)) ||
      (!secret && S.p === "running" && !finished(S.kind === "email" ? EMAIL : SLACK, S.kind) && S.d !== "editsent" && !(S.fromEdit && ["sent", "sentnoreport", "failed", "discarded", "already"].includes(S.d)));
    const shelf = pending
      ? `<div class="composer-shelf"><div class="shelf-row" data-tone="warn">${icon("approval")}<span class="shelf-text">${secret ? "Otto asked you for a secret" : `Otto has a draft waiting for you`}</span><span class="spacer"></span>${button("Review", 'data-d="review" data-size="sm"')}</div></div>`
      : "";
    return (
      `<div class="d-page" data-view="${S.view}">` +
      `<header class="d-head"><span class="avatar" data-bot="otto" style="--size: 26px; width: 26px; height: 26px"></span><h1>Disk almost full on the media box</h1><span class="d-where">Otto</span></header>` +
      `<div class="d-scroll"><div class="d-transcript" id="transcript">` +
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
    let html = `<p class="d-mark"${running ? "" : ' data-tone="danger"'}>${icon(running ? "plug" : "warning")}${pluginWords[S.p]}</p>`;
    html += running
      ? `<div class="b-note">${icon("approval")}<div><p>When a bot sends an email or a message through one of these tools, Clawtrate's drafts plugin holds it here until you send or discard it. It holds only while the plugin runs.</p></div></div>`
      : notRunningNote;
    if (!admin && running) html += accessBar("Changing drafts needs admin access.");
    html += `<h4 class="d-group">Bots</h4>`;
    html += BOTS.map(([id, name]) => {
      const on = S.drafts[id];
      const saving = S.saving === id;
      return (
        `<div class="d-botrow"><span class="avatar" data-bot="${id}"></span><span class="d-botname">${name}</span>` +
        (saving ? `<span class="d-saving">Saving…</span>` : "") +
        (!running ? `<span class="d-mark" data-tone="danger">${icon("warning")}Not held now: the drafts plugin isn't running</span>` : "") +
        `<button type="button" class="b-switch" role="switch" aria-checked="${on}" aria-label="Drafts for ${name}" data-bot-switch="${id}"${!running || !admin || saving ? " disabled" : ""}></button></div>`
      );
    }).join("");
    html += `<h4 class="d-group">Sending tools</h4>`;
    html += `<div class="d-toolrow"><code>${TOOL.email}</code><br />To from <code>to</code>, Cc from <code>cc</code>, Subject from <code>subject</code>, Body from <code>body</code>, files from <code>attachments</code>, From from <code>from</code>.</div>`;
    html += `<div class="d-toolrow"><code>message</code> with <code>action: "send"</code><br />Workspace from <code>accountId</code>, To from <code>target</code>, Thread from <code>threadId</code>, Body from <code>message</code>, files from <code>media</code>.</div>`;
    html += `<p class="d-hint">A tool not on this list never makes a draft; its calls follow the bot's rules.</p>`;
    return settings(html, "Drafts");
  }

  const vaultEntries = () => {
    let list = VAULT.slice();
    if (S.added) list = list.concat([{ name: "PRICE_TRACKER_KEY", kind: "Protected", hosts: ["api.example.com"], updated: "Nov 19", refs: [] }]).sort((a, b) => a.name.localeCompare(b.name));
    if (S.removed) list = list.filter((e) => e.name !== S.item);
    return list;
  };

  function vaultSection() {
    if (S.access !== "admin") return settings(accessBar("Seeing the Vault needs admin access. The gateway shows its secret store to admin connections only."), "Vault");
    const v = S.v;
    if (v === "item" || v === "remove" || v === "replace" || v === "stilllisted" || v === "removeunknown") return settings(itemPage(), "Vault");
    let html = `<div class="b-note">${icon("lock")}<div><p>Secrets on this gateway. Every bot on the gateway can use them, through the hosts each allows; none can read a protected value back.</p></div></div>`;
    html += `<div class="d-vhead">${button("New item", 'data-d="v-new"')}</div>`;
    if (v === "saved") html += `<p class="d-say" data-tone="accent">Saved. PRICE_TRACKER_KEY is in the Vault, Protected, with api.example.com.</p>`;
    if (v === "unconfirmed") html += `<p class="d-say" data-tone="warn">The gateway accepted it, but the Vault couldn't confirm it. Check the list.</p>`;
    if (v === "removed") html += `<p class="d-say" data-tone="accent">Removed. ${EVERY_BOT} can no longer use ${S.item}.</p>`;
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
              `<span class="d-vmeta">${e.kind} · ${e.hosts.length ? e.hosts.join(", ") : "No hosts"} · Updated ${e.updated}</span>${icon("chevron")}</button></li>`,
          )
          .join("") +
        `</ul>`;
    html +=
      `<section class="d-sources"><h4>Where a bot's secrets come from</h4>` +
      `<p>This Vault: values the gateway keeps. A bot never reads a protected value; the gateway uses it for the bot.</p>` +
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
      `<dl class="d-facts"><dt>Name</dt><dd><code>${e.name}</code></dd><dt>Kind</dt><dd>${e.kind}</dd><dt>Allowed hosts</dt><dd>${e.hosts.length ? e.hosts.join(", ") : "No hosts"}</dd>` +
      `<dt>Updated</dt><dd>${e.updated}</dd><dt>Reference</dt><dd><code>store · default · ${e.name}</code></dd></dl>`;
    if (e.kind === "Readable by bots") html += `<p class="d-say" data-tone="warn">Bots can read this value: it is listed to them and given to their commands.</p>`;
    html +=
      `<div class="b-note">${icon("eye")}<div><p><b>Who can use it.</b> Any bot on this gateway can use this through settings that refer to it, and, when the egress proxy is on, in commands on the gateway's machine sent to its hosts. Any bot offered the Secrets tool sees its name and hosts and can remove it. The gateway doesn't limit an item to chosen bots.</p>` +
      `<p class="b-faint">Offered the Secrets tool: ${SECRET_TOOL_BOTS}, as each was last offered, Nov 19.</p></div></div>`;
    if (S.v === "stilllisted") html += `<p class="d-say" data-tone="danger">The gateway answered, but ${e.name} is still listed. ${button("Try again", 'data-d="v-remove-yes" data-size="sm"')}</p>`;
    if (S.v === "removeunknown") html += `<p class="d-say" data-tone="warn">Removed? The gateway answered, but the Vault couldn't be read to confirm. ${button("Check", 'data-d="v-remove-check" data-size="sm"')}</p>`;
    html += `<div class="b-actions" style="margin-top: 16px">${button("Replace…", 'data-d="v-replace"')}${button("Remove…", 'data-d="v-remove" data-tone="danger"', "quiet")}</div>`;
    return html;
  }

  function vaultDialog() {
    const v = S.v;
    if (S.view !== "vault") return "";
    if (v === "new" || v === "replace" || v === "failed" || v === "vsaving") {
      const replace = v === "replace" || (v === "vsaving" && S.replacing);
      const name = replace ? S.item : S.newName || "";
      return (
        `<div class="b-dialog-shim"><dialog class="b-dialog d-dialog" open aria-labelledby="new-title" data-testid="vault-dialog">` +
        `<div class="b-head"><h2 id="new-title">${replace ? `Replace ${S.item}` : "New item"}</h2></div><div class="b-body d-dialog-body">` +
        `<label class="d-fieldlabel" for="v-name">Name</label><input class="input" id="v-name" value="${esc(name)}" ${replace ? "readonly" : ""} placeholder="PRICE_TRACKER_KEY" aria-describedby="v-name-hint" />` +
        `<p class="d-hint" id="v-name-hint">Uppercase letters, digits and _.</p>` +
        (S.badName ? `<p class="d-error">Use letters, digits and _</p>` : "") +
        (replace ? `<p class="d-say" data-tone="warn">${S.item} exists. Saving replaces its value and hosts.</p>` : "") +
        `<label class="d-fieldlabel" for="secret-value">Secret value</label><div class="d-secure"><input class="input" id="secret-value" type="password" autocomplete="off" spellcheck="false" autocapitalize="off" placeholder="Paste or type the value" /></div>` +
        `<span class="d-fieldlabel">Kind</span><div class="d-kind" role="radiogroup" aria-label="Kind"><label><input type="radio" name="v-kind" checked /> Protected</label><label><input type="radio" name="v-kind" /> Readable by bots</label></div>` +
        `<span class="d-fieldlabel">Allowed hosts</span><div class="d-hosts"><span class="d-chip">api.example.com</span></div>` +
        (v === "failed" ? `<p class="d-say" data-tone="danger">Couldn't save: the gateway refused it. Type the value again.</p>` : "") +
        `</div><div class="b-foot b-actions">${button(v === "vsaving" ? "Saving…" : "Save", `data-d="v-save"${v === "vsaving" ? " disabled" : ""}`, "primary")}${button("Cancel", 'data-d="v-cancel"')}</div></dialog></div>`
      );
    }
    if (v === "remove" || v === "removing") {
      const e = VAULT.find((x) => x.name === S.item) || VAULT[2];
      return (
        `<div class="b-dialog-shim"><dialog class="b-dialog d-dialog" data-kind="confirm" role="alertdialog" open aria-labelledby="rm-title" aria-describedby="rm-text" data-testid="remove-dialog">` +
        `<div class="b-head"><h2 id="rm-title">Remove ${e.name}?</h2></div>` +
        `<div class="b-body"><p id="rm-text">Every bot on this gateway loses it: ${EVERY_BOT}. ${e.refs.length ? `Settings that refer to it stop working: <code>${e.refs.join(", ")}</code>.` : "No setting refers to it."} The gateway keeps the removed value for 30 days, then deletes it.</p></div>` +
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
        const save = root.querySelector('[data-d="s-save"]');
        if (save) save.disabled = !S.value;
        if (S.value && S.s === "pending") {
          S.s = "typed";
          sync();
        }
      });
      field.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && S.value) save();
        if (e.key === "Escape") {
          field.value = "";
          S.value = "";
        }
      });
    }
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

  function decide(which) {
    S.last = which;
    go({ d: which === "send" ? "sending" : "discarding" });
    later(() => {
      const a = S.answer;
      if (a === "refused") return go({ d: "refused" }, "The gateway refused this decision");
      if (a === "already") return go({ d: "already" }, "Already answered on another device");
      if (a === "noanswer") return go({ d: "noanswer" }, "No answer from the gateway");
      if (which === "discard") return go({ d: "discarded" }, "Discarded");
      if (S.file === "changed") return go({ d: "filechanged" }, "Not sent");
      if (S.tool === "fails") return go({ d: "failed" }, "Not sent");
      go({ d: S.tool === "silent" ? "sentnoreport" : "sent" }, "Sent");
    });
  }

  function save() {
    go({ s: "saving" });
    later(() => {
      const a = S.answer;
      clearSecret();
      if (a === "refused") return go({ s: "refused" }, "Couldn't save");
      if (a === "already") return go({ s: "already" });
      if (a === "noanswer") return go({ s: "noanswer" });
      S.hostsBack = false;
      go({ s: "saved" }, "Saved securely");
      later(() => go({ hostsBack: true }), 400);
    });
  }

  root.addEventListener("click", (event) => {
    const host = event.target.closest("[data-host]");
    if (host) {
      S.hosts = S.hosts.filter((h) => h !== host.dataset.host);
      return go({ s: S.s === "pending" ? "hosts" : S.s });
    }
    const sw = event.target.closest("[data-bot-switch]");
    if (sw && !sw.disabled) {
      const id = sw.dataset.botSwitch;
      go({ saving: id });
      return later(() => {
        if (S.answer === "refused" || S.answer === "noanswer") {
          go({ saving: null }, "Couldn't save");
          return;
        }
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
      case "check":
        return go({ d: S.fromEdit ? "sent" : "sent" }, "Sent");
      case "fold":
        return go({ folded: !S.folded });
      case "full":
        return go({ d: S.d === "full" ? "pending" : "full" });
      case "raw":
        return say("Raw opened");
      case "review": {
        const card = root.querySelector('[data-testid="draft-new"], [data-testid="draft"], [data-testid="secret"]');
        if (card) {
          card.setAttribute("tabindex", "-1");
          card.focus();
        }
        return;
      }
      case "edit":
        return go({ d: "edit" });
      case "edit-cancel":
        return go({ d: "pending" });
      case "edit-send":
        go({ d: "sending", last: "discard" });
        return later(() => {
          if (S.answer === "refused" || S.answer === "noanswer") return go({ d: "editfailed" }, "Your version wasn't sent");
          S.fromEdit = true;
          go({ d: "editsent" }, "Edits sent to Otto");
          later(() => go({ d: S.newcall === "differs" ? "differs" : "match" }), 700);
        });
      case "show-mine":
        return go({ showMine: !S.showMine });
      case "disable":
        return go({ d: "disable" });
      case "disable-no":
        return go({ d: "pending" });
      case "disable-yes":
        return later(() => {
          if (S.answer === "refused" || S.answer === "noanswer") return go({ d: "disablefailed" }, "Couldn't save");
          S.drafts.otto = false;
          go({ d: "disabled" }, "Drafts off for Otto.");
        }, 300);
      case "request":
        return go({ req: "requested" });
      case "s-save":
        return save();
      case "s-skip":
        clearSecret();
        return go({ s: "skipped" }, "Skipped");
      case "s-check":
        return go({ s: "saved", hostsBack: true }, "Saved securely");
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
        return go({ v: "new", replacing: false });
      case "v-cancel":
        return go({ v: S.replacing ? "item" : "list", badName: false });
      case "v-replace":
        return go({ v: "replace", replacing: true });
      case "v-save": {
        const nameField = document.getElementById("v-name");
        const name = nameField ? nameField.value.trim() : "";
        if (!S.replacing && !/^[A-Z][A-Z0-9_]*$/.test(name)) return go({ badName: true, newName: name });
        go({ v: "vsaving", newName: name, badName: false });
        return later(() => {
          const a = S.vanswer;
          if (a === "refused") return go({ v: "failed" }, "Couldn't save");
          if (a === "unconfirmed") return go({ v: "unconfirmed" });
          if (S.replacing) return go({ v: "item" }, "Saved");
          go({ v: "saved", added: true }, "Saved");
        });
      }
      case "v-back":
        return go({ v: "list" });
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
          if (a === "unconfirmed") return go({ v: "stilllisted" });
          if (a === "refused") return go({ v: "removeunknown" });
          go({ v: "removed", removed: true }, "Removed");
        });
      case "v-remove-check":
        return go({ v: "removed", removed: true }, "Removed");
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

  // The prototype bar: what the gateway answers next, and events ---------------
  document.addEventListener("DOMContentLoaded", () => {
    const extra = document.getElementById("proto-extra");
    if (!extra) return;
    const sel = (label, key, options) =>
      `<label class="proto-seg">${label} <select data-proto="${key}">${options.map(([v, t]) => `<option value="${v}"${S[key] === v ? " selected" : ""}>${t}</option>`).join("")}</select></label>`;
    extra.innerHTML =
      sel("Gateway answers", "answer", [["applied", "Applied"], ["refused", "Refused"], ["already", "Already answered"], ["noanswer", "No answer"]]) +
      sel("Vault", "vanswer", [["confirmed", "Confirmed"], ["unconfirmed", "Unconfirmed"], ["refused", "Unreadable / refused"]]) +
      sel("Tool result", "tool", [["reports", "Reports what it sent"], ["silent", "Says nothing"], ["fails", "Fails"]]) +
      sel("Otto's new call", "newcall", [["matches", "Matches"], ["differs", "Differs"]]) +
      `<button type="button" data-proto-event="file">Change report.txt</button>` +
      `<button type="button" data-proto-event="expire">Expire</button>` +
      `<button type="button" data-proto-event="close">Run ends</button>` +
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
      go({ d: ev === "expire" ? "expired" : ev === "close" ? "closed" : "cancelled" });
    });
  });

  // The secret card starts from the address with a typed value where the state needs one.
  if (S.view === "secret" && S.s === "typed") S.value = "••••";
  render();
  if (S.view === "secret" && S.s === "typed") {
    const f = document.getElementById("secret-value");
    if (f) {
      f.value = "example-secret-value";
      const s = root.querySelector('[data-d="s-save"]');
      if (s) s.disabled = false;
    }
  }
})();
