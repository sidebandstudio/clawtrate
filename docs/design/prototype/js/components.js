// Markup for every conversation component, one function each. Each returns an
// HTML string. The gallery and the scripted conversation both build from
// these, so there is one copy of the markup. The functions follow the
// boundaries the React components are expected to have.

(function () {
  const CT = (window.CT = window.CT || {});

  CT.bots = {
    juniper: { name: "Juniper", label: "Research" },
    marlow: { name: "Marlow", label: "Writing" },
    otto: { name: "Otto", label: "Operations" },
    pip: { name: "Pip", label: "Planning" },
  };

  const esc = (text) =>
    String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  CT.esc = esc;

  const stateWord = {
    idle: "idle",
    thinking: "thinking",
    working: "working",
    waiting: "waiting for you",
    blocked: "blocked",
    done: "done",
    failed: "failed",
    stopped: "stopped",
  };
  CT.stateWord = stateWord;

  const icon = (name, cls) => CT.icon(name, cls);

  CT.glyph = (state) => `<span class="glyph" data-state="${state}" aria-hidden="true"></span>`;

  CT.avatar = (bot, state = "idle") =>
    `<span class="avatar" aria-hidden="true">${CT.character(bot, state)}</span>`;

  CT.agentMark = () => `<span class="agent-mark" aria-hidden="true">${icon("code")}</span>`;

  // The avatar with its state. Badged states: waiting, blocked, failed, stopped.
  // `badge` overrides the badge, for waiting while the machine is unreachable.
  CT.presence = (bot, state = "idle", { size, label = true, badge, i } = {}) => {
    const mark = badge || (["waiting", "blocked", "failed", "stopped"].includes(state) ? state : "");
    const name = CT.bots[bot].name;
    return (
      `<span class="presence" data-state="${state}"${size ? ` data-size="${size}"` : ""}` +
      (i ? ` style="--i:${i}"` : "") +
      (label ? ` role="img" aria-label="${name}, ${stateWord[state]}"` : ' aria-hidden="true"') +
      `>${CT.avatar(bot, state)}${mark ? CT.glyph(mark) : ""}</span>`
    );
  };

  // Transcript pieces ------------------------------------------------------------

  CT.stamp = (text) => `<div class="stamp">${text}</div>`;

  CT.msg = ({ role = "assistant", html, md = false, streaming = false, pending = "", id = "" }) =>
    `<div class="msg" data-role="${role}"${pending ? ` data-pending="${pending}"` : ""}${id ? ` id="${id}"` : ""}>` +
    `<div class="bubble${md ? " md" : ""}"${streaming ? ' aria-busy="true"' : ""}>${html}` +
    `${streaming ? '<span class="stream-caret"></span>' : ""}</div></div>`;

  CT.caption = (html, tone = "") => `<div class="msg-caption"${tone ? ` data-tone="${tone}"` : ""}>${html}</div>`;

  CT.eventLine = (html) => `<div class="event-line">${html}</div>`;

  CT.linkButton = (label, { icon: name, tone, action } = {}) =>
    `<button type="button" class="link-button"${tone ? ` data-tone="${tone}"` : ""}${action ? ` data-action="${action}"` : ""}>` +
    `${esc(label)}${name ? icon(name) : ""}</button>`;

  CT.button = (label, attrs = "") => `<button type="button" class="button" data-size="sm" ${attrs}>${label}</button>`;

  // Status line -------------------------------------------------------------------

  CT.statusLine = ({ bot, state = "thinking", phrase = "", elapsed = "", fresh = false, badge }) => {
    const name = CT.bots[bot].name;
    const face = state === "stopping" ? "idle" : state;
    const spoken = `${name}, ${stateWord[face]}${phrase ? `: ${phrase}` : ""}. Show steps.`;
    return (
      `<button type="button" class="status-line" data-state="${state}" data-action="status" aria-label="${esc(spoken)}"` +
      (phrase ? ` title="${esc(phrase)}"` : "") +
      `>${CT.presence(bot, face, { label: false, badge })}` +
      (phrase ? `<span class="status-phrase"${fresh ? ' data-fresh="true"' : ""}>${esc(phrase)}</span>` : "") +
      (elapsed ? `<span class="status-elapsed">${elapsed}</span>` : "") +
      `</button>`
    );
  };

  // Steps -------------------------------------------------------------------------

  const copyButton = (what) =>
    `<button type="button" class="copy" aria-label="Copy ${esc(what)}" title="Copy ${esc(what)}">${icon("copy")}</button>`;
  CT.copyButton = copyButton;

  CT.codeBlock = ({ label, text, copy = label, clipped = false, lines, tone, live = false }) =>
    `<div class="code-head"><p class="code-label">${esc(label)}</p>${copyButton(copy.toLowerCase())}</div>` +
    `<pre class="code-block"${clipped ? ' data-clipped="true"' : ""}${tone ? ` data-tone="${tone}"` : ""}` +
    `${live ? ' data-live="true"' : ""} tabindex="0">${esc(text)}${live ? '<span class="stream-caret"></span>' : ""}</pre>` +
    (clipped
      ? `<p class="code-more"><button type="button" class="link-button" data-action="unclip">Show all ${lines} lines</button></p>`
      : "");

  CT.fields = (rows) =>
    `<dl class="fields">` +
    rows
      .map(
        ([key, value, opts = {}]) =>
          `<dt>${esc(key)}</dt><dd><span${opts.mono ? ' class="mono"' : ""}>${esc(value)}</span>` +
          `${opts.copy ? copyButton(key.toLowerCase()) : ""}</dd>`,
      )
      .join("") +
    `</dl>`;

  // The detail of one step: a readable view, and what the gateway sent.
  // raw for a tool call: { tool, args, result | error, timing, ids }.
  // raw for a thought, message or approval step: { event, ids }, the event as received.
  CT.stepBody = ({ readable, raw, view = "readable" }) => {
    let rawHtml = "";
    if (raw) {
      const ids = `<p class="code-label">Identifiers</p>` + CT.fields(raw.ids.map(([k, v]) => [k, v, { mono: true, copy: true }]));
      rawHtml =
        `<div data-view="raw"${view === "raw" ? "" : " hidden"}>` +
        (raw.event
          ? CT.codeBlock({ label: "Event as received", text: raw.event, copy: "event" }) + ids
          : `<dl class="fields"><dt>Tool</dt><dd><span class="tool-name">${esc(raw.tool)}</span>${copyButton("tool name")}</dd></dl>` +
            CT.codeBlock({ label: "Arguments", text: raw.args }) +
            (raw.error
              ? CT.codeBlock({ label: "Error", text: raw.error, tone: "danger" })
              : raw.result
                ? CT.codeBlock({ label: "Result", text: raw.result, clipped: raw.clipped, lines: raw.lines })
                : `<p class="exchange-note" style="margin-bottom:12px">No result yet. This call is still running.</p>`) +
            `<p class="code-label">Timing</p>` +
            CT.fields(raw.timing) +
            ids) +
        `</div>`;
    }
    return (
      `<div class="step-body">` +
      (raw
        ? `<div class="step-tools"><div class="seg" role="tablist" aria-label="Detail view">` +
          `<button type="button" role="tab" aria-selected="${view === "readable"}" data-view-button="readable">Readable</button>` +
          `<button type="button" role="tab" aria-selected="${view === "raw"}" data-view-button="raw">Raw</button></div></div>`
        : "") +
      `<div data-view="readable"${view === "raw" ? " hidden" : ""}>${readable}</div>` +
      rawHtml +
      `</div>`
    );
  };

  const stepIcon = {
    read: "read",
    write: "write",
    list: "list",
    search: "search",
    web: "web",
    command: "command",
    thought: "thought",
    message: "message",
    agent: "code",
    approval: "approval",
    memory: "memory",
    tool: "tool",
  };

  // One step. status: running, done, failed, waiting, skipped.
  CT.step = ({ id, kind = "tool", status = "done", title, detail = "", statusText = "", open = false, body = "", fresh = false }) =>
    `<li><details class="step" data-kind="${kind}" data-status="${status}"${id ? ` id="${id}"` : ""}` +
    `${open ? " open" : ""}${fresh ? ' data-fresh="true"' : ""}>` +
    `<summary title="${esc(title)}"><span class="step-node">${status === "running" ? CT.glyph("working") : icon(stepIcon[kind] || "tool")}</span>` +
    `<span class="step-title">${esc(title)}</span>` +
    `<span class="step-detail">${detail}</span>` +
    `<span class="step-status">${statusText}</span>` +
    `${icon("chevron", "icon chevron")}</summary>` +
    `${body}</details></li>`;

  // The activity block. state: running, completed, stopped, failed.
  CT.activity = ({ id, state = "running", label, count = "", failed = 0, open = false, steps = "", foot = "", failedSteps = "" }) =>
    `<details class="activity" data-state="${state}"${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
    `<summary class="activity-head"><span class="activity-label">${esc(label)}</span>` +
    (count ? `<span aria-hidden="true">·</span><span class="activity-count">${esc(count)}</span>` : "") +
    (failed ? `<span aria-hidden="true">·</span><span class="activity-failed">${failed} failed</span>` : "") +
    `${icon("chevron", "icon chevron")}</summary><ol class="activity-steps">${steps}</ol>` +
    (foot ? `<p class="activity-foot">${foot}</p>` : "") +
    `</details>` +
    `<ol class="activity-failed-steps">${failedSteps}</ol>`;

  // Messaged card -----------------------------------------------------------------

  const states = {
    sending: ["sending", "Sending", ""],
    approval: ["waiting", "Waiting for approval", "warn"],
    sent: ["check", "Sent", ""],
    working: ["working", "Working", "accent"],
    "recipient-waiting": ["waiting", "Recipient waiting", "warn"],
    "no-reply": ["queued", "No reply yet", ""],
    unknown: ["idle", "Unknown", ""],
    "delivery-unknown": ["idle", "Delivery unknown", ""],
    replied: ["check", "Replied", "accent"],
    done: ["check", "Done", "accent"],
    failed: ["failed", "Failed", "danger"],
    blocked: ["failed", "Blocked by policy", "danger"],
    "not-sent": ["stopped", "Not sent", ""],
    "recipient-stopped": ["stopped", "Recipient stopped", ""],
    // The receiving side follows the recipient's own run.
    "waiting-you": ["waiting", "Waiting for you", "warn"],
    completed: ["check", "Completed", ""],
    stopped: ["stopped", "Stopped", ""],
  };

  CT.state = (key) => {
    const [glyph, word, tone] = states[key];
    return `<span class="state" data-state="${key}"${tone ? ` data-tone="${tone}"` : ""}>${CT.glyph(glyph)}${word}</span>`;
  };

  // target: a bot id, or "t3code". verb: "Messaged" or "Message from".
  CT.messaged = ({ id, target, verb = "Messaged", first, state, open = false, body = "" }) => {
    const who = target === "t3code" ? `${CT.agentMark()}T3 Code` : `${CT.avatar(target)}${CT.bots[target].name}`;
    return (
      `<details class="card messaged" data-target="${target}" data-state="${state}"${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
      `<summary><span class="messaged-verb">${verb}</span>` +
      `<span class="messaged-who">${who}</span>` +
      `<span class="messaged-first">${esc(first)}</span>${CT.state(state)}${icon("chevron", "icon chevron")}</summary>` +
      `<div class="messaged-body">${body}</div></details>`
    );
  };

  // One side of an exchange. who: a bot id or "t3code".
  CT.exchangeItem = ({ who, verb, time, html }) =>
    `<li class="exchange-item">${who === "t3code" ? CT.agentMark() : CT.avatar(who)}` +
    `<div><div class="exchange-meta"><b>${who === "t3code" ? "T3 Code" : CT.bots[who].name}</b>` +
    `<span>${verb}</span>${time ? `<time>${time}</time>` : ""}</div>${html}</div></li>`;

  CT.exchange = (items) => `<ol class="exchange">${items.map(CT.exchangeItem).join("")}</ol>`;

  CT.cardActions = (html) => `<div class="card-actions">${html}</div>`;

  // Request cards -----------------------------------------------------------------

  CT.fullRequest = ({ reason, command, fields, open = false }) =>
    `<details class="request-full"${open ? " open" : ""}><summary>` +
    `<span class="when-closed">Show full request</span><span class="when-open">Hide full request</span>${icon("chevron", "icon chevron")}</summary>` +
    `<div class="request-inset"><p class="request-reason">${esc(reason)}</p>` +
    `<div class="command-line"><code>${esc(command)}</code>${copyButton("command")}</div>` +
    CT.fields(fields) +
    `${CT.linkButton("Raw", { tone: "muted" })}</div></details>`;

  // The standing-allow form. lasts: "1 hour", "1 day" or "Until I revoke".
  CT.standing = ({ bot, rule, scope = "bot", lasts = "1 day", open = false }) => {
    const name = CT.bots[bot].name;
    const seg = (label, key, options, picked) =>
      `<div class="seg" role="radiogroup" aria-label="${label}" data-standing="${key}">` +
      options
        .map((o) => `<button type="button" role="radio" aria-checked="${o === picked}">${o}</button>`)
        .join("") +
      `</div>`;
    return (
      `<div class="standing" role="group" aria-label="Always allow" data-bot="${name}"${open ? "" : " hidden"}>` +
      `<div class="standing-grid"><span>Rule</span><span><code class="tool-name">${esc(rule)}</code></span>` +
      `<span>Applies to</span>${seg("Applies to", "scope", [`${name} only`, "All bots"], scope === "bot" ? `${name} only` : "All bots")}` +
      `<span>Lasts</span>${seg("Lasts", "lasts", ["1 hour", "1 day", "Until I revoke"], lasts)}</div>` +
      `<p class="standing-outcome">${CT.standingOutcome(name, scope === "bot" ? `${name} only` : "All bots", lasts)}</p>` +
      `<div class="request-actions"><button type="button" class="button" data-variant="primary" data-decision="always">Allow and save rule</button>` +
      `<button type="button" class="button" data-variant="quiet" data-action="standing-close">Back</button></div></div>`
    );
  };

  CT.standingOutcome = (name, scope, lasts) => {
    const who = scope === "All bots" ? "Every bot" : name;
    const until = lasts === "1 hour" ? "for the next hour" : lasts === "1 day" ? "until this time tomorrow" : "until you revoke it";
    return `${who} can do this without asking ${until}. You can revoke it in Permissions.`;
  };

  // A pending approval. `what` completes "<Bot> wants to …".
  CT.approval = ({ id, bot, what = "run a command", summary, warnings = [], full, foot = "", standing, standingOpen = false, noRule = false }) => {
    const name = CT.bots[bot].name;
    return (
      `<section class="card request" data-kind="approval" data-state="pending"${id ? ` id="${id}"` : ""} tabindex="-1" aria-label="${name} wants to ${esc(what)}. Needs approval.">` +
      `<header class="request-head"><h3 class="request-title">${name} wants to ${esc(what)}</h3>` +
      `<span class="tag" data-tone="warn">Needs approval</span></header>` +
      `<p class="request-summary">${summary}</p>` +
      (warnings.length
        ? `<ul class="request-warnings">${warnings.map((w) => `<li>${icon("warning")}${esc(w)}</li>`).join("")}</ul>`
        : "") +
      CT.fullRequest(full) +
      `<div class="request-actions"${standingOpen ? " hidden" : ""}>` +
      `<button type="button" class="button" data-variant="primary" data-decision="once">${noRule ? "Allow" : "Allow once"}</button>` +
      (noRule ? "" : `<button type="button" class="button" data-action="standing-open">Always allow…</button>`) +
      `<span class="spacer"></span>` +
      `<button type="button" class="button" data-variant="quiet" data-decision="deny">Deny</button></div>` +
      (standing ? CT.standing({ bot, ...standing, open: standingOpen }) : "") +
      (foot ? `<p class="request-foot">${foot}</p>` : "") +
      `</section>`
    );
  };

  const resolved = {
    once: ["Allowed once", "accent"],
    always: ["Always allowed", "accent"],
    denied: ["Denied", ""],
    expired: ["Expired", ""],
    "closed-message": ["Closed by your message", ""],
    "closed-ended": ["Closed: the run ended", ""],
    "closed-failed": ["Closed: the run failed", ""],
    cancelled: ["Cancelled", ""],
  };

  // A resolved approval: one line that opens to the outcome and the request.
  CT.approvalResolved = ({ id, state, line, when, outcome = "", rule = "", full, open = false }) => {
    const [word, tone] = resolved[state];
    return (
      `<details class="card request" data-kind="approval" data-state="${state}" data-resolved${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
      `<summary><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${word}</span>` +
      `<span class="request-line">${line}</span><time class="request-when">${when}</time>${icon("chevron", "icon chevron")}</summary>` +
      `<div class="request-resolved-body">${outcome ? `<p>${outcome}</p>` : ""}${rule}` +
      CT.fullRequest({ ...full, open: true }) +
      `</div></details>`
    );
  };

  const letters = ["A", "B", "C", "D", "E", "F"];

  // A pending question. options: [label, sub?]. picked: indexes already chosen.
  CT.question = ({ id, title, options, multi = false, picked = [], own = "" }) =>
    `<section class="card request" data-kind="question" data-state="pending"${id ? ` id="${id}"` : ""} tabindex="-1" aria-label="Question: ${esc(title)}">` +
    `<header class="request-head"><h3 class="request-title">${esc(title)}</h3>` +
    `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss this question" title="Dismiss">${icon("x")}</button></header>` +
    (multi ? `<p class="request-hint">Choose all that apply.</p>` : "") +
    `<ul class="options" role="${multi ? "group" : "radiogroup"}" aria-label="${esc(title)}">` +
    options
      .map(
        ([label, sub], i) =>
          `<li><button type="button" class="option" role="${multi ? "checkbox" : "radio"}" aria-checked="${picked.includes(i)}">` +
          `<span class="option-key" aria-hidden="true">${letters[i]}</span>` +
          `<span>${esc(label)}${sub ? `<span class="option-sub">${esc(sub)}</span>` : ""}</span>${CT.glyph("check")}</button></li>`,
      )
      .join("") +
    `</ul>` +
    `<label class="own-answer"><span class="visually-hidden">Type your own answer</span>` +
    `<input type="text" placeholder="Type your own answer" value="${esc(own)}">` +
    `<button type="button" class="icon-button" aria-label="Send answer"${own ? "" : " disabled"}>${icon("arrow-up")}</button></label>` +
    (multi
      ? `<div class="request-actions"><button type="button" class="button" data-variant="primary"${picked.length ? "" : " disabled"}>Send answer</button>` +
        `<span class="request-foot" style="margin:0 0 0 4px">${picked.length ? `${picked.length} chosen` : "Nothing chosen yet"}</span></div>`
      : "") +
    `</section>`;

  // An answered, dismissed or expired question. answers: [letter, text].
  CT.questionAnswered = ({ title, answers = [], state = "answered", note = "" }) =>
    `<section class="card request" data-kind="question" data-state="${state}" aria-label="Question, ${state}: ${esc(title)}">` +
    `<h3 class="request-title">${esc(title)}</h3>` +
    answers
      .map(
        ([letter, text]) =>
          `<div class="answer">${letter ? `<span class="option-key" aria-hidden="true">${letter}</span>` : "<span></span>"}` +
          `<span>${esc(text)}</span>${state === "answered" ? CT.glyph("check") : ""}</div>`,
      )
      .join("") +
    (note ? `<p class="request-foot" style="margin-top:8px">${note}</p>` : "") +
    `</section>`;

  // Composer ----------------------------------------------------------------------

  CT.shelfRow = ({ tone = "", lead = "", text, actions = "" }) =>
    `<div class="shelf-row"${tone ? ` data-tone="${tone}"` : ""}>${lead}<span class="shelf-text">${text}</span>${actions}</div>`;

  // run: idle, running, waiting, stopping, offline, readonly. mode: steer or queue.
  CT.composer = ({ bot, run = "idle", text = "", shelf = "", menu = false, jump = "", mode = "steer" }) => {
    const name = CT.bots[bot].name;
    const active = run === "running" || run === "waiting";
    const placeholder = {
      idle: `Message ${name}`,
      running: `Steer ${name}`,
      waiting: `Answer above, or message ${name}`,
      stopping: `Queue a message for ${name}`,
      offline: "Offline. You can keep writing.",
    }[run];
    const sendLabel = active ? (mode === "queue" ? "Queue after this turn" : "Steer this turn") : run === "stopping" ? "Queue" : "Send";
    return (
      `<footer class="composer" data-run="${run}">${jump}<div class="composer-inner">` +
      `<div class="composer-shelf">${shelf}</div>` +
      `<div class="composer-box">` +
      `<button type="button" class="icon-button" aria-label="Attach files" title="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" rows="1" aria-label="Message ${name}" placeholder="${placeholder}">${esc(text)}</textarea>` +
      (active && text
        ? `<button type="button" class="send-mode" data-action="send-menu" aria-haspopup="menu" aria-expanded="${menu}" aria-label="Send mode: ${mode === "queue" ? "Queue" : "Steer"}">${mode === "queue" ? "Queue" : "Steer"}${icon("chevron")}</button>`
        : "") +
      (run === "stopping" ? `<span class="composer-status">Stopping…</span>` : "") +
      (active
        ? `<button type="button" class="icon-button stop-button" data-action="stop" aria-label="Stop ${name}" title="Stop (⌘.)"></button>`
        : "") +
      `<button type="button" class="icon-button send-button" data-action="send" aria-label="${sendLabel}" title="${sendLabel}"${text && run !== "offline" ? "" : " disabled"}>${icon("arrow-up")}</button>` +
      (menu ? CT.sendMenu(active, mode) : "") +
      `</div></div></footer>`
    );
  };

  CT.sendMenu = (active, mode = "steer") =>
    `<ul class="menu" role="menu" aria-label="How to send">` +
    (active
      ? `<li><button type="button" class="menu-item" role="menuitemradio" aria-checked="${mode === "steer"}" data-active="${mode === "steer"}" data-mode="steer">${icon("arrow-up")}Steer this turn<kbd>↵</kbd></button></li>` +
        `<li><button type="button" class="menu-item" role="menuitemradio" aria-checked="${mode === "queue"}" data-active="${mode === "queue"}" data-mode="queue">${icon("queue")}Queue after this turn<kbd>⌥↵</kbd></button></li>`
      : `<li><button type="button" class="menu-item" role="menuitem" data-active="true" data-mode="send">${icon("arrow-up")}Send<kbd>↵</kbd></button></li>`) +
    `<li><button type="button" class="menu-item" role="menuitem" data-mode="new-task">${icon("new-task")}Start as new task<kbd>⇧⌘↵</kbd></button></li></ul>`;

  // Jump to latest. state: latest, live, needs-you.
  CT.jump = ({ state = "latest", bot, phrase = "", hidden = false, up = false }) =>
    `<button type="button" class="jump" data-state="${state}" data-action="jump"${hidden ? " hidden" : ""}>` +
    (state === "live"
      ? `${CT.presence(bot, "working", { size: "sm", label: false })}<span>${esc(phrase)}</span>`
      : state === "needs-you"
        ? `${CT.glyph("waiting")}<span>${esc(phrase || "Needs you")}</span>`
        : `<span>${esc(phrase || "Jump to latest")}</span>`) +
    `${icon(up ? "arrow-up" : "arrow-down")}</button>`;

  // Errors and notes ----------------------------------------------------------------

  CT.turnError = ({ title, reason, actions }) =>
    `<div class="card turn-error" role="alert">${icon("warning")}<p class="turn-error-title">${esc(title)}</p>` +
    `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss">${icon("x")}</button>` +
    `<p class="turn-error-reason">${reason}</p><div class="turn-error-actions">${actions}</div></div>`;

  CT.turnNote = ({ lead, html }) => `<div class="turn-note">${lead}<div>${html}</div></div>`;

  // The status strip (.status-strip in the shell).
  const strips = {
    reconnecting: ["warn", "reconnecting", "Reconnecting", "showing saved messages", "Retry now"],
    offline: ["danger", "error", "Can't reach Home gateway", "showing saved messages", "Retry now"],
    syncing: ["warn", "connecting", "Connected", "catching up", ""],
    synced: ["ok", "connected", "Synced", "3 new in this task", ""],
    failed: ["danger", "error", "Couldn't sync this task", "", "Try again"],
  };

  CT.banner = (name, attrs = "") => {
    const [tone, status, text, more, action] = strips[name];
    return (
      `<div class="status-strip" role="status" data-tone="${tone}" ${attrs}><span class="status-dot" data-status="${status}"></span>` +
      `<span class="status-strip-text">${text}${more ? `<span>· ${more}</span>` : ""}</span>${action ? `<button type="button">${action}</button>` : ""}</div>`
    );
  };

  // Rail rows -------------------------------------------------------------------------

  // status: idle, running, waiting, blocked, failed, done-failed, unread, queued.
  const taskMarks = {
    running: ["working", "", "working"],
    waiting: ["waiting", "", "needs you"],
    blocked: ["blocked", "", "blocked"],
    failed: ["failed", "", "last run failed"],
    "done-failed": ["failed", "", "done with failures"],
    unread: ["unread", "", "unread"],
    queued: ["queued", "", "queued"],
  };

  CT.taskRow = ({ title, status = "idle", current = false, id = "" }) => {
    const mark = taskMarks[status];
    return (
      `<li><button type="button" class="task"${id ? ` id="${id}"` : ""} aria-current="${current}" data-status="${status}"` +
      `${status === "unread" ? ' data-unread="true"' : ""} aria-label="${esc(title)}${mark ? `, ${mark[2]}` : ""}">` +
      `<span class="task-title">${esc(title)}</span>` +
      (mark ? `<span class="task-end">${mark[1] ? `<span class="task-word">${mark[1]}</span>` : ""}${CT.glyph(mark[0])}</span>` : "") +
      `</button></li>`
    );
  };

  // A bot row with its tasks. state is the most urgent state among its tasks.
  CT.botGroup = ({ bot, state = "idle", preview, time, mark = "", open = false, current = false, tasks = "", i = 0, id = "" }) => {
    const b = CT.bots[bot];
    const spoken = `${b.name}, ${stateWord[state]}${mark === "unread" ? ", unread" : mark === "failed" ? ", done with failures" : ""}`;
    return (
      `<li class="bot-group"${open ? ' data-open="true"' : ""}${id ? ` id="${id}"` : ""}>` +
      `<button type="button" class="bot" aria-current="${current}"${tasks ? ` aria-expanded="${open}"` : ""} aria-label="${spoken}">` +
      `${CT.presence(bot, state, { label: false, i })}` +
      `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${time}</time></span>` +
      `<span class="bot-line"><span class="bot-preview" data-state="${state}">${esc(preview)}</span>` +
      `${mark === "unread" ? '<span class="unread-dot"></span>' : mark ? CT.glyph(mark) : ""}</span></span></button>` +
      (open && tasks ? `<ul class="task-list" aria-label="${b.name}'s tasks">${tasks}</ul>` : "") +
      `</li>`
    );
  };
})();
