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

  let counter = 0;
  CT.uid = (prefix = "ct") => `${prefix}-${++counter}`;
  CT.defs = {}; // what each pending request card was built from, by id

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

  // A stand-in for a bot's own picture: a small drawn scene, cropped to a circle.
  CT.picture = () =>
    `<span class="avatar avatar-picture" aria-hidden="true"><svg viewBox="0 0 40 40">` +
    `<rect width="40" height="40" fill="#7fb7e6"/><circle cx="29" cy="11" r="5" fill="#ffe08a"/>` +
    `<path d="M0 30 12 16l8 9 6-6 14 13v8H0z" fill="#3f7d5c"/><path d="M0 34c8-4 14-3 20 0s14 3 20-1v7H0z" fill="#2d5f45"/></svg></span>`;

  CT.agentMark = () => `<span class="agent-mark" aria-hidden="true">${icon("code")}</span>`;

  // The avatar with its state. Badged states: waiting, blocked, failed, stopped.
  // `badge` overrides the badge, for waiting while the machine is unreachable.
  // `image` draws a bot that has its own picture: the ring and the badge say the state.
  CT.presence = (bot, state = "idle", { size, label = true, badge, i, image = false } = {}) => {
    const mark = badge || (["waiting", "blocked", "failed", "stopped"].includes(state) ? state : "");
    const name = CT.bots[bot].name;
    return (
      `<span class="presence" data-state="${state}"${size ? ` data-size="${size}"` : ""}${image ? ' data-kind="image"' : ""}` +
      (i ? ` style="--i:${i}"` : "") +
      (label ? ` role="img" aria-label="${name}, ${stateWord[state]}"` : ' aria-hidden="true"') +
      `>${image ? CT.picture() : CT.avatar(bot, state)}${mark ? CT.glyph(mark) : ""}</span>`
    );
  };

  // Transcript pieces ------------------------------------------------------------

  CT.stamp = (text) => `<div class="stamp">${text}</div>`;

  // pending: "held", a message the host is holding until the connection returns.
  CT.msg = ({ role = "assistant", html, md = false, streaming = false, pending = "", id = "" }) =>
    `<div class="msg" data-role="${role}"${pending ? ` data-pending="${pending}"` : ""}${id ? ` id="${id}"` : ""}>` +
    `<div class="bubble${md ? " md" : ""}"${streaming ? ' aria-busy="true"' : ""}>${html}` +
    `${streaming ? '<span class="stream-caret"></span>' : ""}</div></div>`;

  CT.caption = (html, tone = "") => `<div class="msg-caption"${tone ? ` data-tone="${tone}"` : ""}>${html}</div>`;

  CT.eventLine = (html) => `<div class="event-line">${html}</div>`;

  // An event line that opens: a message no card accounts for, or a count line.
  CT.eventDetails = ({ line, body }) =>
    `<details class="event-details"><summary class="event-line">${line}${icon("chevron", "icon chevron")}</summary>` +
    `<div class="card event-body">${body}</div></details>`;

  CT.linkButton = (label, { icon: name, tone, action, attrs = "", name: spoken } = {}) =>
    `<button type="button" class="link-button"${tone ? ` data-tone="${tone}"` : ""}${action ? ` data-action="${action}"` : ""}` +
    `${spoken ? ` aria-label="${esc(spoken)}"` : ""} ${attrs}>${esc(label)}${name ? icon(name) : ""}</button>`;

  CT.button = (label, attrs = "") => `<button type="button" class="button" data-size="sm" ${attrs}>${label}</button>`;

  // Status line -------------------------------------------------------------------

  // The phrase is never empty: "Thinking" stands until something more specific is known.
  CT.statusLine = ({ bot, state = "thinking", phrase = "Thinking", elapsed = "", fresh = false, badge, steps = true }) => {
    const name = CT.bots[bot].name;
    const face = state === "stopping" ? "idle" : state;
    const spoken = `${name}, ${stateWord[face]}: ${phrase}.${steps ? " Show steps." : " No steps yet."}`;
    return (
      `<button type="button" class="status-line" data-state="${state}" data-action="status" aria-label="${esc(spoken)}" title="${esc(phrase)}">` +
      `${CT.presence(bot, face, { label: false, badge })}` +
      `<span class="status-phrase"${fresh ? ' data-fresh="true"' : ""}>${esc(phrase)}</span>` +
      (elapsed ? `<span class="status-elapsed">${elapsed}</span>` : "") +
      `</button>`
    );
  };

  // Copy, code and fields ------------------------------------------------------------

  // A copy button names exactly what it copies, and carries that text.
  const copyButton = (what, text, note = "") =>
    `<button type="button" class="copy" aria-label="Copy ${esc(what)}" title="Copy ${esc(what)}" data-what="${esc(what)}"` +
    `${text === undefined ? "" : ` data-copy="${esc(text)}"`}${note ? ` data-copy-note="${esc(note)}"` : ""}>${icon("copy")}</button>`;
  CT.copyButton = copyButton;

  const countLines = (text) => text.replace(/\n$/, "").split("\n").length;

  // Long output shows eight whole lines, then "Show all N lines". `truncated`
  // marks a result the gateway cut before sending.
  CT.codeBlock = ({ label, text, copy = label, tone, live = false, truncated = false, limit = 8 }) => {
    const lines = countLines(text);
    const clipped = !live && lines > limit;
    return (
      `<div class="code-head"><p class="code-label">${esc(label)}</p>` +
      `${copyButton(copy.toLowerCase(), text, truncated ? "what was received" : "")}</div>` +
      `<pre class="code-block"${clipped ? ' data-clipped="true"' : ""}${tone ? ` data-tone="${tone}"` : ""}` +
      `${live ? ' data-live="true"' : ""} tabindex="0">${esc(text)}${live ? '<span class="stream-caret"></span>' : ""}</pre>` +
      (truncated
        ? `<p class="code-truncated">${icon("warning")}Truncated by the gateway. ` +
          // The size is given only for plain text; a structured result is not a simple prefix.
          `${truncated === "structured" ? "The rest was not sent." : `${text.length.toLocaleString("en-US")} characters were received; the rest was not sent.`}</p>`
        : "") +
      (clipped
        ? `<p class="code-more"><button type="button" class="link-button" data-action="unclip" data-lines="${lines}" aria-expanded="false">Show all ${lines} lines</button></p>`
        : "")
    );
  };

  CT.fields = (rows) =>
    `<dl class="fields">` +
    rows
      .map(
        ([key, value, opts = {}]) =>
          `<dt>${esc(key)}</dt><dd><span${opts.mono ? ' class="mono"' : ""}>${esc(value)}</span>` +
          `${opts.copy ? copyButton(opts.what || key.toLowerCase(), value) : ""}</dd>`,
      )
      .join("") +
    `</dl>`;

  CT.note = (html) => `<p class="exchange-note">${html}</p>`;

  // Raw: what the gateway sent ---------------------------------------------------------
  //
  // One component for every step and card.
  //   A tool call:   { tool, args, result | error | running, truncated, timing, ids }
  //   Anything else: { events: [[label, text]], timing?, ids }
  //   Not loaded:    { state: "loading" | "unavailable" | "failed", reason }
  CT.raw = (raw) => {
    if (raw.state === "loading") return `<p class="raw-state" aria-busy="true">Loading what the gateway sent…</p>`;
    if (raw.state === "unavailable") return `<p class="raw-state">${esc(raw.reason || "The gateway did not keep this event.")}</p>`;
    if (raw.state === "failed") {
      return `<p class="raw-state" data-tone="danger">Couldn't load what the gateway sent. ${CT.linkButton("Try again", { action: "raw-retry" })}</p>`;
    }
    const copyRows = (rows, what) => rows.map(([k, v]) => [k, v, { mono: true, copy: true, what: what(k) }]);
    return (
      `<p class="raw-note">Sample data. A part that says “as the gateway sends it” follows the gateway's schema; the others are samples in the app's own shape.</p>` +
      (raw.tool
        ? `<dl class="fields"><dt>Tool</dt><dd><span class="tool-name">${esc(raw.tool)}</span>${copyButton("tool name", raw.tool)}</dd></dl>`
        : "") +
      (raw.args !== undefined ? CT.codeBlock({ label: "Arguments", text: raw.args }) : "") +
      (raw.error
        ? CT.codeBlock({ label: "Error", text: raw.error, tone: "danger" })
        : raw.result
          ? CT.codeBlock({ label: "Result", text: raw.result, truncated: raw.truncated ? "structured" : false })
          : raw.running
            ? `<p class="exchange-note" style="margin-bottom:12px">No result yet. This call is still running.</p>`
            : "") +
      (raw.events || []).map(([label, text]) => CT.codeBlock({ label, text, copy: label })).join("") +
      (raw.timing ? `<p class="code-label">Timing</p>` + CT.fields(copyRows(raw.timing, (k) => `${k.toLowerCase()} time`)) : "") +
      `<p class="code-label">Identifiers</p>` +
      CT.fields(copyRows(raw.ids, (k) => `${k.toLowerCase()} id`)) +
      (raw.tool
        ? `<p class="raw-record">${CT.linkButton("Open in the gateway's action record", { icon: "external", action: "elsewhere", attrs: 'data-where="Opens the gateway\'s record of tool actions at this call: its time, bot, task, run, call and outcome. That screen is not part of this design."' })}</p>`
        : "")
    );
  };

  // The Raw button on a card, and the panel it opens. Returns both pieces.
  CT.rawDisclosure = (raw, open = false) => {
    const id = CT.uid("raw");
    return {
      button: `<button type="button" class="link-button" data-tone="muted" data-action="raw" aria-expanded="${open}" aria-controls="${id}">Raw</button>`,
      panel: `<div class="raw-panel" id="${id}" role="region" aria-label="What the gateway sent"${open ? "" : " hidden"}>${CT.raw(raw)}</div>`,
    };
  };

  // A card's last row: its actions, then Raw at the right, then the Raw panel.
  CT.cardFoot = (actions, raw, rawOpen = false) => {
    const { button, panel } = raw ? CT.rawDisclosure(raw, rawOpen) : { button: "", panel: "" };
    return `<div class="card-actions">${actions}<span class="spacer"></span>${button}</div>${panel}`;
  };

  // Steps -------------------------------------------------------------------------

  // The detail of one step: a readable view and what the gateway sent, as two
  // tabs. Every step has both. state: "loading" or "failed" while its detail is fetched.
  CT.stepBody = ({ readable = "", raw, view = "readable", state = "" }) => {
    if (state === "loading") return `<div class="step-body"><p class="raw-state" aria-busy="true">Loading this step…</p></div>`;
    if (state === "failed") {
      return `<div class="step-body"><p class="raw-state" data-tone="danger">Couldn't load this step. ${CT.linkButton("Try again", { action: "step-retry" })}</p></div>`;
    }
    const id = CT.uid("step");
    const tab = (key, label) =>
      `<button type="button" role="tab" id="${id}-tab-${key}" aria-controls="${id}-${key}" aria-selected="${view === key}"` +
      ` tabindex="${view === key ? 0 : -1}" data-view-button="${key}">${label}</button>`;
    const panel = (key, html) =>
      `<div role="tabpanel" id="${id}-${key}" aria-labelledby="${id}-tab-${key}" data-view="${key}"${view === key ? "" : " hidden"}>${html}</div>`;
    return (
      `<div class="step-body">` +
      `<div class="step-tools"><div class="seg" role="tablist" aria-label="Detail view">${tab("readable", "Readable")}${tab("raw", "Raw")}</div></div>` +
      panel("readable", readable || CT.note("The gateway sent no result for this step.")) +
      panel("raw", CT.raw(raw || { state: "unavailable" })) +
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
    `${body || CT.stepBody({})}</details></li>`;

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

  // The block's footer: the run's model and effort as reported, and the run id.
  CT.activityFoot = ({ model, effort, run }) =>
    `<span>${esc(model || "model not reported")}</span><span>${effort ? `${esc(effort)} effort requested` : "effort not reported"}</span>` +
    `<span class="mono">${esc(run)}</span>${copyButton("run id", run)}`;

  // Messaged cards ------------------------------------------------------------------

  // Each state is something an event established: [mark, word, tone].
  const states = {
    "call-started": ["sending", "Call started", ""],
    approval: ["waiting", "Waiting for approval", "warn"],
    sent: ["check", "Sent", ""],
    working: ["working", "Working", "accent"],
    "recipient-waiting": ["waiting", "Recipient waiting", "warn"],
    "no-reply": ["queued", "No reply yet", ""],
    replied: ["check", "Replied", "accent"],
    "recipient-stopped": ["stopped", "Recipient stopped", ""],
    "recipient-failed": ["failed", "Recipient failed", "danger"],
    failed: ["failed", "Failed", "danger"],
    blocked: ["failed", "Blocked by policy", "danger"],
    "not-sent": ["stopped", "Not sent", ""],
    unknown: ["queued", "Unknown", ""],
    // T3 Code.
    "call-made": ["check", "Call made", ""],
    "delivery-unknown": ["queued", "Delivery unknown", ""],
    // The receiving side follows the recipient's own run.
    "waiting-you": ["waiting", "Waiting for you", "warn"],
    completed: ["check", "Completed", ""],
    stopped: ["stopped", "Stopped", ""],
  };
  CT.stateWords = Object.fromEntries(Object.entries(states).map(([key, value]) => [key, value[1]]));

  // lastSeen: the connection is lost, so the word is what was last known.
  CT.state = (key, lastSeen = false) => {
    const [glyph, word, tone] = states[key];
    const text = lastSeen ? `Last seen ${word.toLowerCase()}` : word;
    return `<span class="state" data-state="${key}"${tone ? ` data-tone="${tone}"` : ""}>${CT.glyph(glyph)}${text}</span>`;
  };

  // target: a bot id, or "t3code". verb: "Messaged" or "Message from".
  CT.messaged = ({ id, target, verb = "Messaged", first, state, open = false, body = "" }) => {
    const t3 = target === "t3code";
    const who = t3 ? `${CT.agentMark()}T3 Code` : `${CT.avatar(target)}${CT.bots[target].name}`;
    const name = t3 ? "T3 Code" : CT.bots[target].name;
    return (
      `<details class="card messaged" data-target="${target}" data-state="${state}"${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
      `<summary aria-label="${verb} ${name}: ${esc(first)} ${CT.stateWords[state]}."><span class="messaged-verb">${verb}</span>` +
      `<span class="messaged-who">${who}</span>` +
      `<span class="messaged-first">${esc(first)}</span>${CT.state(state)}${icon("chevron", "icon chevron")}</summary>` +
      `<div class="messaged-body">${body}</div></details>`
    );
  };

  // One side of an exchange. who: a bot id or "t3code". lead: replaces the avatar,
  // for the recipient's live state.
  CT.exchangeItem = ({ who, verb, time, html = "", lead }) =>
    `<li class="exchange-item">${lead || (who === "t3code" ? CT.agentMark() : CT.avatar(who))}` +
    `<div><div class="exchange-meta"><b>${who === "t3code" ? "T3 Code" : CT.bots[who].name}</b>` +
    `<span>${verb}</span>${time ? `<time>${time}</time>` : ""}</div>${html}</div></li>`;

  CT.exchange = (items, attrs = "") => `<ol class="exchange" ${attrs}>${items.map(CT.exchangeItem).join("")}</ol>`;

  // What the card can say about the other side, for each state.
  CT.cameBack = (state, { sender, recipient, phrase, reply, time, error, rule, denied, timeout }) => {
    const s = CT.bots[sender].name;
    const t3 = recipient === "t3code";
    const r = t3 ? "T3 Code" : CT.bots[recipient].name;
    const line = (text) => ({ who: recipient, verb: "", html: CT.note(text) });
    switch (state) {
      case "approval":
        return line(`This ${t3 ? "call" : "message"} waits for your approval. Nothing has been sent.`);
      case "call-started":
        return line(`${s} began this call. Nothing yet shows that it was made${t3 ? ", and nothing more is reported until it returns" : ""}.`);
      case "sent":
        return line(`${r} received it. No reply yet.`);
      case "working":
        // One row: the recipient's state avatar, its name and its current phrase.
        return { who: recipient, verb: `· ${esc(phrase)}`, lead: CT.presence(recipient, "working", { label: false, size: "sm" }) };
      case "recipient-waiting":
        return line(`${r} asked a question in its own task and is waiting for the answer.`);
      case "no-reply":
        return line(
          `${timeout ? "The message was sent, and no reply came in time." : `${r}'s run finished without a reply.`} A reply that names this message appears here; any other arrives as a message from ${r}.`,
        );
      case "replied":
        return { who: recipient, verb: "replied", time, html: `<div class="exchange-text">${reply}</div>` };
      case "recipient-stopped":
        return line(`${r}'s run for this message was stopped before it replied.`);
      case "recipient-failed":
        return line(`${r} received it, and its run for this message then failed: the model provider was overloaded.`);
      case "failed":
        return { who: recipient, verb: "", html: CT.note("The call failed.") + CT.codeBlock({ label: "Error", text: error, tone: "danger" }) };
      case "blocked":
        return line(`A messaging rule stopped this: ${esc(rule)}. Nothing was sent.`);
      case "not-sent":
        return line(denied ? "You denied the approval. Nothing was sent." : `${s} was stopped before the call was made. Nothing was sent.`);
      case "unknown":
      case "delivery-unknown":
        return line(`${s} was stopped before the call returned. The gateway cannot say whether ${r} received it.`);
      case "call-made":
        return {
          who: recipient,
          verb: "· the call returned",
          time,
          html: `<div class="exchange-text">${reply}</div>` + CT.note("This shows the call was made. It does not show that the work is finished."),
        };
      default:
        return line("");
    }
  };

  // Request cards -----------------------------------------------------------------

  // review: the automatic review's line. cause: { text, label, where }, why the
  // gateway asked and the action that goes with it ("Edit rule", "Manage settings").
  CT.fullRequest = ({ reason, command, fields, review = "", cause, open = false }) =>
    `<details class="request-full"${open ? " open" : ""}><summary>` +
    `<span class="when-closed">Show full request</span><span class="when-open">Hide full request</span>${icon("chevron", "icon chevron")}</summary>` +
    `<div class="request-inset"><p class="request-reason">${esc(reason)}</p>` +
    `<div class="command-line"><code>${esc(command)}</code>${copyButton("command", command)}</div>` +
    CT.fields(fields.concat(review ? [["Review", review]] : [])) +
    (cause
      ? `<p class="request-cause">${esc(cause.text)} ${CT.linkButton(cause.label, { action: "elsewhere", attrs: `data-where="${esc(cause.where)}"` })}</p>`
      : "") +
    `</div></details>`;

  // "Always allow" shows what the request carries and nothing else: the gateway
  // names no rule in advance and returns none. `request` is the request's own
  // fields; `kind` says what the gateway keeps for a request of that kind:
  //   "command"  an entry on the host's allowlist, with no expiry
  //   "routine"  a standing grant for a routine's command, with a lifetime in days
  //   "other"    whatever the gateway keeps for that kind
  CT.requestRows = (request) =>
    `<dl class="standing-grid">` +
    [
      ["Command", request.command && `<code class="tool-name">${esc(request.command)}</code>`],
      ["Folder", request.cwd && `<code class="tool-name">${esc(request.cwd)}</code>`],
      ["Runs on", request.host && esc(request.host)],
      ["Bot", request.agent && esc(request.agent)],
      ["For", request.routine && `The routine ${esc(request.routine)}`],
    ]
      .filter(([, value]) => value) // a field the request does not carry has no row
      .map(([label, value]) => `<dt>${label}</dt><dd>${value}</dd>`)
      .join("") +
    `</dl>`;

  const until = (days) => {
    const date = new Date(2026, 10, 16 + Number(days));
    const text = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return date.getFullYear() === 2026 ? text : `${text}, ${date.getFullYear()}`;
  };
  CT.until = until;

  // What "Always allow" saves, in words, no more precisely than the gateway decides it.
  CT.savedWords = (kind, request, bot) => {
    const name = CT.bots[bot].name;
    if (kind === "routine") return `The routine ${request.routine} may run this command without asking.`;
    if (kind === "other") return "The gateway will remember this decision for requests it treats as the same.";
    return `The gateway will add this to ${request.host}'s allowlist, so ${name} is not asked again for commands it matches. The gateway decides what that covers; it can be wider than this exact command.`;
  };

  // The form, and what happens to a decision. Deny stays in every state.
  // sent: "" (open), "sending", "refused", "unknown". nextTime: the rules plugin's variant.
  CT.standing = ({ bot, request, kind = "command", open = false, sent = "", reason = "", days = "", nextTime = false }) => {
    const lifetime =
      kind === "routine" && !sent
        ? `<label class="days">Lasts <input type="number" min="1" max="3650" step="1" inputmode="numeric" value="${days}" placeholder="default" aria-label="Number of days"> days</label>` +
          `<p class="days-error" hidden>Between 1 and 3650 days.</p>`
        : "";
    const body =
      sent === "sending"
        ? `<p class="standing-outcome" aria-busy="true">Sending your decision…</p>`
        : sent === "refused"
          ? `<div class="standing-error" role="alert"><b>The gateway refused this decision.</b> ${esc(reason)} The request is still open.</div>`
          : sent === "unknown"
            ? `<div class="standing-note" role="status">${icon("warning")}<span><b>No answer from the gateway.</b> Your decision may or may not have been applied.</span></div>`
            : `<p class="standing-outcome">${esc(CT.savedWords(kind, request, bot))}</p>${lifetime}`;
    const primary = nextTime
      ? `<button type="button" class="button" data-variant="primary" data-decision="next-time">Save rule for next time</button>`
      : sent === "sending"
        ? `<button type="button" class="button" data-variant="primary" disabled>Sending…</button>`
        : sent === "refused"
          ? `<button type="button" class="button" data-variant="primary" data-decision="always">Try again</button>` +
            `<button type="button" class="button" data-decision="once">Allow once instead</button>`
          : sent === "unknown"
            ? `<button type="button" class="button" data-variant="primary" data-action="check-decision">Check again</button>`
            : `<button type="button" class="button" data-variant="primary" data-decision="always">Allow and save</button>`;
    return (
      `<div class="standing" role="group" aria-label="Always allow" data-bot="${bot}" data-kind="${kind}"${sent ? ` data-sent="${sent}"` : ""}${open ? "" : " hidden"}>` +
      CT.requestRows(request) +
      body +
      `<div class="request-actions">${primary}` +
      (sent === "unknown" ? "" : `<button type="button" class="button" data-variant="quiet" data-action="standing-close"${sent === "sending" ? " disabled" : ""}>Back</button>`) +
      (nextTime ? "" : `<span class="spacer"></span><button type="button" class="button" data-variant="quiet" data-decision="deny">Deny</button>`) +
      `</div></div>`
    );
  };

  // A pending approval. `what` completes "<Bot> wants to …".
  // decisions: the decisions this request offers; Deny is always among them.
  // request, kind: what the "Always allow" form shows (see CT.standing).
  // asker: { title, line } when a helper or a messaged bot is asking.
  // runEnded: the run is over and the request is still pending.
  // readonly: this device can read the request and cannot answer it.
  CT.approval = ({
    id, bot, what = "run a command", summary, line = "", warnings = [], full, foot = "", request, kind = "command",
    decisions = ["once", "always", "deny"], asker, formOpen = false, sent = "", sentReason = "", days = "", runEnded = false,
    readonly = false, raw, rawOpen = false,
  }) => {
    const name = CT.bots[bot].name;
    const title = asker?.title || `${name} wants to ${what}`;
    const always = decisions.includes("always") && request;
    id = id || CT.uid("approval");
    CT.defs[id] = { bot, line, full, request, kind, raw };
    return (
      `<section class="card request" data-kind="approval" data-state="pending" id="${id}" data-line="${esc(line)}" tabindex="-1"` +
      ` role="region" aria-label="${esc(title)}. Needs approval.">` +
      `<header class="request-head"><h3 class="request-title">${esc(title)}</h3>` +
      `<span class="tag" data-tone="warn">Needs approval</span></header>` +
      `<p class="request-summary">${summary}</p>` +
      (asker?.line ? `<p class="request-asker">${esc(asker.line)}</p>` : "") +
      (warnings.length
        ? `<ul class="request-warnings">${warnings.map((w) => `<li>${icon("warning")}${esc(w)}</li>`).join("")}</ul>`
        : "") +
      (runEnded ? `<p class="request-ended">${name}'s run has ended. This request is still open, and you can still answer it.</p>` : "") +
      CT.fullRequest(full) +
      (readonly
        ? `<p class="request-ended">You can read this request but not answer it from this device.</p>` +
          `<div class="request-actions"><button type="button" class="button" data-variant="primary" data-action="request-access">Request access</button></div>`
        : `<div class="request-actions" data-row="main"${formOpen ? " hidden" : ""}>` +
          `<button type="button" class="button" data-variant="primary" data-decision="once">${always ? "Allow once" : "Allow"}</button>` +
          (always ? `<button type="button" class="button" data-action="standing-open" aria-expanded="${formOpen}">Always allow…</button>` : "") +
          `<span class="spacer"></span>` +
          `<button type="button" class="button" data-variant="quiet" data-decision="deny">Deny</button></div>` +
          (always ? CT.standing({ bot, request, kind, open: formOpen, sent, reason: sentReason, days }) : "")) +
      (foot ? `<p class="request-foot">${foot}</p>` : "") +
      CT.cardFoot("", raw, rawOpen) +
      `</section>`
    );
  };

  const resolved = {
    once: ["Allowed once", "accent"],
    always: ["Always allowed", "accent"],
    denied: ["Denied", ""],
    expired: ["Expired", ""],
    "closed-ended": ["Closed: the run ended", ""],
    "closed-failed": ["Closed: the run failed", ""],
    cancelled: ["Cancelled", ""],
  };

  // What the gateway reported, and no more. Allowing is not proof of running.
  CT.outcomes = (name) => ({
    once: `Allowed once. The command can run now. ${name} will ask again next time.`,
    always: "Allowed, and saved. The command can run now.",
    denied: `Denied. The command was not run. ${name} won't do this, and won't ask again until you send another message.`,
    expired: "Expired at 5:53 PM without an answer. The command was not run.",
    "closed-ended": "The run ended before this was answered. The command was not run.",
    "closed-failed": "The run failed before this was answered. The command was not run.",
    cancelled: "You stopped the run before answering. The command was not run.",
  });

  // A resolved approval: one line that opens to the outcome and the request.
  // saved: { kind, request, days } what "allow always" kept, in the form's own words.
  // winner: who decided, when another decision won. nextTime: the rules plugin's form.
  CT.approvalResolved = ({ id, bot = "otto", state, line, when, outcome, saved, winner = "", nextTime, full, open = false, raw }) => {
    const [word, tone] = resolved[state];
    const name = CT.bots[bot].name;
    const kept = saved
      ? saved.kind === "routine"
        ? `${CT.savedWords("routine", saved.request, bot).replace(/\.$/, "")}, ${saved.days ? `until ${until(saved.days)}` : "for the gateway's default time"}.`
        : saved.kind === "other"
          ? "The gateway will remember this decision for requests it treats as the same."
          : `Added to ${saved.request.host}'s allowlist. The gateway decides what it covers. Seeing that list needs admin access.`
      : "";
    return (
      `<details class="card request" data-kind="approval" data-state="${state}" data-resolved${id ? ` id="${id}"` : ""}${open ? " open" : ""}>` +
      `<summary><span class="tag"${tone ? ` data-tone="${tone}"` : ""}>${word}</span>` +
      `<span class="request-line">${line}</span><time class="request-when">${when}</time>${icon("chevron", "icon chevron")}</summary>` +
      `<div class="request-resolved-body"><p>${outcome || CT.outcomes(name)[state]}${winner ? ` ${esc(winner)}` : ""}</p>` +
      (kept
        ? `<p>${esc(kept)}</p><p class="request-foot">${CT.linkButton("Saved rules", { action: "elsewhere", attrs: 'data-where="Opens Settings, Permissions. Standing grants are listed and revoked there with the access that answers approvals; a host\'s allowlist needs admin."' })}</p>`
        : "") +
      (nextTime
        ? `<div class="request-actions" data-row="main"><button type="button" class="button" data-action="standing-open" aria-expanded="false">Always allow next time</button></div>` +
          CT.standing({ bot, ...nextTime, nextTime: true })
        : "") +
      CT.fullRequest({ ...full, open: true }) +
      CT.cardFoot("", raw) +
      `</div></details>`
    );
  };

  const letters = ["A", "B", "C", "D"];

  // A pending question card: one to three questions, each with two to four
  // options, optionally several answers, and always a field for the user's own.
  // questions: [{ title, options: [label, sub?], multi, picked: [indexes], own }]
  CT.question = ({ id, bot = "otto", questions, title, options, multi = false, picked = [], own = "", raw }) => {
    const list = questions || [{ title, options, multi, picked, own }];
    const name = CT.bots[bot].name;
    const several = list.length > 1;
    id = id || CT.uid("question");
    CT.defs[id] = { bot, questions: list, raw };
    const instant = !several && !list[0].multi; // one question, one answer: choosing answers
    const block = (q, index) => {
      const chosen = q.picked || [];
      const focusIndex = chosen.length ? chosen[0] : 0;
      return (
        `<div class="question" data-index="${index}" data-multi="${Boolean(q.multi)}">` +
        (several ? `<h4 class="question-title"><span>${index + 1} of ${list.length}</span>${esc(q.title)}</h4>` : "") +
        (q.multi ? `<p class="request-hint">Choose all that apply.</p>` : "") +
        `<ul class="options" role="${q.multi ? "group" : "radiogroup"}" aria-label="${esc(q.title)}">` +
        q.options
          .map(
            ([label, sub], i) =>
              `<li><button type="button" class="option" role="${q.multi ? "checkbox" : "radio"}" aria-checked="${chosen.includes(i)}"` +
              ` tabindex="${i === focusIndex ? 0 : -1}" data-letter="${letters[i]}">` +
              `<span class="option-key" aria-hidden="true">${letters[i]}</span>` +
              `<span>${esc(label)}${sub ? `<span class="option-sub">${esc(sub)}</span>` : ""}</span>${CT.glyph("check")}</button></li>`,
          )
          .join("") +
        `</ul>` +
        `<label class="own-answer"><span class="visually-hidden">Type your own answer${several ? ` to question ${index + 1}` : ""}</span>` +
        `<input type="text" placeholder="Type your own answer" value="${esc(q.own || "")}">` +
        (instant
          ? `<button type="button" class="icon-button" data-action="answer-own" aria-label="Send this answer"${q.own ? "" : " disabled"}>${icon("arrow-up")}</button>`
          : "") +
        `</label></div>`
      );
    };
    const answered = list.filter((q) => (q.picked || []).length || q.own).length;
    const count = several
      ? `${answered} of ${list.length} answered`
      : (list[0].picked || []).length
        ? `${list[0].picked.length} chosen`
        : "Nothing chosen yet";
    return (
      `<section class="card request" data-kind="question" data-state="pending"${id ? ` id="${id}"` : ""} tabindex="-1" role="region"` +
      ` aria-label="${name} asks: ${esc(list[0].title)}">` +
      `<header class="request-head"><h3 class="request-title">${several ? `${name} has ${list.length} questions` : esc(list[0].title)}</h3>` +
      `<button type="button" class="icon-button" data-variant="quiet" data-action="dismiss-question" aria-label="Dismiss ${name}'s question${several ? "s" : ""}" title="Dismiss">${icon("x")}</button></header>` +
      list.map(block).join("") +
      (instant
        ? ""
        : `<div class="request-actions"><button type="button" class="button" data-variant="primary" data-action="send-answers"${answered === list.length ? "" : " disabled"}>` +
          `${several ? "Send answers" : "Send answer"}</button><span class="request-foot question-count">${count}</span></div>`) +
      CT.cardFoot("", raw) +
      `</section>`
    );
  };

  // A question record outside the ordinary ask-user subset: shown readable, with
  // its Raw, and no way to answer it here.
  CT.questionReadOnly = ({ id, bot = "otto", questions, status = "pending", raw }) =>
    `<section class="card request" data-kind="question" data-state="unanswerable"${id ? ` id="${id}"` : ""} tabindex="-1" role="region"` +
    ` aria-label="${CT.bots[bot].name} asked something this app can't answer yet">` +
    `<h3 class="request-title">${CT.bots[bot].name} asked something this app can't answer yet</h3>` +
    questions
      .map(
        (q) =>
          `<p class="request-summary">${esc(q.question)}</p>` +
          (q.options.length ? `<p class="request-foot">Options: ${q.options.map(esc).join(" · ")}</p>` : "") +
          (q.why ? `<p class="request-foot">${esc(q.why)}</p>` : ""),
      )
      .join("") +
    `<p class="request-foot">State: ${status}. Nothing is sent for it from here.</p>` +
    CT.cardFoot("", raw) +
    `</section>`;

  const questionNotes = {
    dismissed: "Dismissed",
    expired: "Expired without an answer",
    cancelled: "Cancelled: you stopped the run",
    "closed-ended": "Closed: the run ended",
    "closed-failed": "Closed: the run failed",
  };

  // A question card after it was answered, dismissed, expired or closed.
  // questions: [{ title, answers: [letter, text] }]
  CT.questionAnswered = ({ id, questions, title, answers = [], state = "answered", raw }) => {
    const list = questions || [{ title, answers }];
    return (
      `<section class="card request" data-kind="question" data-state="${state}"${id ? ` id="${id}"` : ""} tabindex="-1" aria-label="Question, ${state}: ${esc(list[0].title)}">` +
      list
        .map(
          (q) =>
            `<h3 class="request-title">${esc(q.title)}</h3>` +
            (state === "answered"
              ? q.answers
                  .map(
                    ([letter, text]) =>
                      `<div class="answer">${letter ? `<span class="option-key" aria-hidden="true">${letter}</span>` : "<span></span>"}` +
                      `<span>${esc(text)}</span>${CT.glyph("check")}</div>`,
                  )
                  .join("")
              : `<div class="answer"><span></span><span>${questionNotes[state]}</span></div>`),
        )
        .join("") +
      CT.cardFoot("", raw) +
      `</section>`
    );
  };

  // Composer ----------------------------------------------------------------------

  CT.shelfRow = ({ tone = "", lead = "", text, actions = "" }) =>
    `<div class="shelf-row"${tone ? ` data-tone="${tone}"` : ""}>${lead}<span class="shelf-text">${text}</span>${actions}</div>`;

  // Attachments in the pill. The gateway's limits are checked as files are added.
  // files: [{ name, size (in MB), image }]
  const MB = (n) => `${n % 1 ? n.toFixed(1) : n} MB`;
  CT.attachmentProblems = (files) => {
    const each = files.map((f) => (f.image && f.size > 6 ? "Images can be up to 6 MB." : !f.image && f.size > 20 ? "Files can be up to 20 MB." : ""));
    const total = files.reduce((sum, f) => sum + f.size, 0);
    return { each, total, over: total > 25, any: each.some(Boolean) || total > 25 };
  };
  CT.attachments = (files) => {
    if (!files.length) return "";
    const problems = CT.attachmentProblems(files);
    return (
      `<div class="attachments"><ul class="chips">` +
      files
        .map(
          (f, i) =>
            `<li class="chip"${problems.each[i] ? ' data-tone="danger"' : ""}>${icon("file")}<b>${esc(f.name)}</b>` +
            `<span>${MB(f.size)}${problems.each[i] ? `. ${problems.each[i]}` : ""}</span>` +
            `<button type="button" class="chip-remove" data-action="remove-file" data-index="${i}" aria-label="Remove ${esc(f.name)}">${icon("x")}</button></li>`,
        )
        .join("") +
      `</ul>` +
      (problems.over ? `<p class="attachments-note" id="attach-note">${MB(problems.total)} attached. A message can carry up to 25 MB.</p>` : "") +
      `</div>`
    );
  };

  // run: idle, running, waiting, stopping, offline. pending: "approval" or "question".
  // mode: what plain Enter does during a run: steer or queue. A pending question makes it hold.
  CT.composer = ({ bot, run = "idle", pending = "", text = "", shelf = "", menu = false, mode = "steer", files = [] }) => {
    const name = CT.bots[bot].name;
    const active = run === "running" || run === "waiting";
    const effective = !active ? (run === "stopping" ? "queue" : "send") : pending === "question" ? "hold" : mode;
    const placeholder = {
      idle: `Message ${name}`,
      running: `Steer ${name}`,
      waiting: `Answer above, or message ${name}`,
      stopping: `Queue a message for ${name}`,
      offline: "Offline. Messages send when you reconnect.",
    }[run];
    const words = { steer: "Steer", queue: "Queue", hold: "Hold" };
    const sendLabel = { send: "Send", steer: "Steer this turn", queue: "Queue after this turn", hold: "Hold until you answer" }[effective];
    const problems = CT.attachmentProblems(files);
    const empty = !text.trim() && !files.length;
    const reason = problems.any ? "Remove what is over the limit to send." : "";
    return (
      `<footer class="composer" data-run="${run}"><div class="composer-inner">` +
      `<div class="composer-shelf">${shelf}</div>` +
      `<div class="composer-box"${files.length ? ' data-files="true"' : ""}>` +
      CT.attachments(files) +
      `<div class="composer-row">` +
      `<button type="button" class="icon-button" data-action="attach" aria-label="Attach files" title="Attach files">${icon("plus")}</button>` +
      `<textarea class="composer-input" rows="1" aria-label="Message ${name}" placeholder="${placeholder}">${esc(text)}</textarea>` +
      (active && text
        ? `<button type="button" class="send-mode" data-action="send-menu" aria-haspopup="menu" aria-expanded="${menu}" aria-label="How to send: ${words[effective]}">${words[effective]}${icon("chevron")}</button>`
        : "") +
      (run === "stopping" ? `<span class="composer-status">Stopping…</span>` : "") +
      (active
        ? `<button type="button" class="icon-button stop-button" data-action="stop" aria-label="Stop ${name}" title="Stop (⌘.)"></button>`
        : "") +
      `<button type="button" class="icon-button send-button" data-action="send" aria-label="${sendLabel}" title="${reason || sendLabel}"` +
      `${reason ? ' aria-describedby="attach-note"' : ""}${active ? "" : ' aria-haspopup="menu"'}${empty || problems.any ? " disabled" : ""}>${icon("arrow-up")}</button>` +
      (menu ? CT.sendMenu(active, effective) : "") +
      `</div></div></div></footer>`
    );
  };

  // The ways to send. The current mode is the checked item.
  CT.sendMenu = (active, mode = "steer", { sheet = false } = {}) => {
    const item = (key, label, keys, name, role = "menuitem") =>
      `<li role="none"><button type="button" class="menu-item" role="${role}"${role === "menuitemradio" ? ` aria-checked="${mode === key}"` : ""}` +
      ` data-active="${mode === key}" data-mode="${key}">${icon(name)}${label}${sheet ? "" : `<kbd>${keys}</kbd>`}</button></li>`;
    const first = mode === "hold" ? item("hold", "Hold until you answer", "↵", "arrow-up", "menuitemradio") : item("steer", "Steer this turn", "↵", "arrow-up", "menuitemradio");
    return (
      `<ul class="menu send-menu" role="menu" aria-label="How to send">` +
      (active
        ? first + item("queue", "Queue after this turn", "⌥↵", "queue", "menuitemradio")
        : item("send", "Send", "↵", "arrow-up")) +
      item("new-task", "Start as new task", "⇧⌘↵", "new-task") +
      `</ul>`
    );
  };

  // The access bar: what stands in the composer's place on a read-only connection.
  // state: read, asking, requested, denied, expired, failed, none.
  CT.accessBar = ({ bot, state = "read", seconds = 4, reason = "" }) => {
    const name = CT.bots[bot].name;
    const command = "openclaw devices approve 7c41d09e";
    const rows = {
      read: [
        `${icon("eye")}<span class="shelf-text"><b>Read-only.</b> You can follow ${name}'s work here. Approvals and questions aren't shown on this connection.</span>`,
        `<button type="button" class="button" data-size="sm" data-variant="primary" data-action="request-access">Request access</button>`,
      ],
      asking: [`${CT.glyph("sending")}<span class="shelf-text" aria-busy="true">Asking the gateway…</span>`, ""],
      requested: [
        `${CT.glyph("waiting")}<span class="shelf-text"><b>Waiting for the gateway's owner.</b> Approve this request on the gateway's machine:</span>`,
        "",
      ],
      denied: [
        `${CT.glyph("stopped")}<span class="shelf-text"><b>The request was denied.</b> Nothing changed. This device can still read.</span>`,
        CT.button("Request again", 'data-action="request-access"'),
      ],
      expired: [
        `${CT.glyph("stopped")}<span class="shelf-text"><b>The request expired</b> before it was approved.</span>`,
        CT.button("Request again", 'data-action="request-access"'),
      ],
      failed: [
        `${icon("warning")}<span class="shelf-text"><b>Couldn't send the request.</b> ${esc(reason)}</span>`,
        CT.button("Try again", 'data-action="request-access"'),
      ],
      none: [`${icon("eye")}<span class="shelf-text"><b>Read-only.</b> This gateway does not let this device send.</span>`, ""],
    };
    const [text, actions] = rows[state];
    return (
      `<footer class="composer" data-run="read"><div class="composer-inner">` +
      `<section class="access-bar" role="region" aria-label="Access" data-state="${state}"${state === "failed" ? ' data-tone="danger"' : ""}>` +
      `<div class="access-row">${text}${actions}</div>` +
      (state === "requested"
        ? `<div class="command-line"><code>${command}</code>${copyButton("approve command", command)}</div>` +
          `<div class="access-row"><span class="access-id">Request <span class="mono">7c41d09e</span>${copyButton("request id", "7c41d09e")}` +
          `<span class="access-wait">checking again in ${seconds}s</span></span><span class="spacer"></span>` +
          CT.button("Check now", 'data-action="access-check"') +
          CT.button("Cancel request", 'data-variant="quiet" data-action="access-cancel"') +
          `</div>`
        : "") +
      `</section></div></footer>`
    );
  };

  // Jump to latest: the shell's .jump-latest, with the states a run needs.
  // state: latest, live, needs-you. face: the bot's real state, for live.
  CT.jump = ({ state = "latest", bot, phrase = "", hidden = false, up = false, face = "working" }) =>
    `<button type="button" class="jump-latest" data-state="${state}" data-action="jump" data-testid="jump-latest"${hidden ? " hidden" : ""}>` +
    (state === "live"
      ? `${CT.presence(bot, face, { size: "sm", label: false })}<span>${esc(phrase)}</span>`
      : state === "needs-you"
        ? `${CT.glyph("waiting")}<span>${esc(phrase || "Needs you")}</span>`
        : `<span>${esc(phrase || "Jump to latest")}</span>`) +
    `${icon(up ? "arrow-up" : "arrow-down")}</button>`;

  // Errors and notes ----------------------------------------------------------------

  CT.turnError = ({ title, reason, requestId = "", raw, retry = true }) => {
    const disclosure = raw ? CT.rawDisclosure(raw) : null;
    return (
    `<div class="card turn-error" role="alert">${icon("warning")}<p class="turn-error-title">${esc(title)}</p>` +
    `<button type="button" class="icon-button" data-variant="quiet" data-action="dismiss-error" aria-label="Dismiss this error">${icon("x")}</button>` +
    `<p class="turn-error-reason">${reason}</p><div class="turn-error-actions">` +
    (retry ? CT.button("Try again", 'data-action="retry-turn"') : "") +
    (requestId ? CT.linkButton("Copy request ID", { tone: "muted", attrs: `data-copy="${esc(requestId)}" data-what="request ID"`, action: "copy-text" }) : "") +
    (disclosure ? `<span class="spacer"></span>${disclosure.button}` : "") +
    `</div>${disclosure ? disclosure.panel : ""}</div>`
    );
  };

  CT.turnNote = ({ lead, html }) => `<div class="turn-note">${lead}<div>${html}</div></div>`;

  // The status strip (.status-strip in the shell): its own dot by tone, a state
  // that always shows in full, and an explanation that may shorten.
  const strips = {
    reconnecting: ["warn", "Reconnecting in 4s", "showing saved messages", "Retry now"],
    offline: ["danger", "Can't reach Home gateway", "showing saved messages", "Retry now"],
    syncing: ["warn", "Connected", "catching up", ""],
    synced: ["ok", "Synced", "3 new in this task", ""],
    failed: ["danger", "Couldn't sync this task", "", "Try again"],
    granted: ["ok", "Access granted", "you can send, stop and answer", ""],
  };

  CT.banner = (name, attrs = "", more) => {
    const [tone, text, explain, action] = strips[name];
    const tail = more === undefined ? explain : more;
    return (
      `<div class="status-strip" role="status" data-tone="${tone}" ${attrs}><span class="status-dot"></span>` +
      `<span class="status-strip-text">${text}${tail ? `<span>· ${tail}</span>` : ""}</span>` +
      `${action ? `<button type="button" data-action="strip-action">${action}</button>` : ""}</div>`
    );
  };

  // Rail rows -------------------------------------------------------------------------

  // A task row: the title, the time of its last activity, and at most one mark.
  // status: idle, running, waiting, blocked, failed, done-failed, unread, stopped, queued.
  const taskMarks = {
    running: ["working", "working"],
    waiting: ["waiting", "needs you"],
    blocked: ["blocked", "blocked"],
    failed: ["failed", "last run failed"],
    "done-failed": ["failed", "done with failures"],
    stopped: ["stopped", "stopped"],
    queued: ["queued", "queued"],
  };

  CT.taskRow = ({ title, status = "idle", current = false, id = "", time = "" }) => {
    const mark = taskMarks[status];
    const spoken = title + (time ? `, ${time}` : "") + (mark ? `, ${mark[1]}` : status === "unread" ? ", unread" : "");
    return (
      `<li><button type="button" class="task"${id ? ` id="${id}"` : ""} aria-current="${current}" data-status="${status}"` +
      ` data-unread="${status === "unread"}" aria-label="${esc(spoken)}"><span class="task-title">${esc(title)}</span>` +
      (time ? `<time class="task-time">${time}</time>` : "") +
      (mark ? CT.glyph(mark[0]) : status === "unread" ? '<span class="unread-dot" aria-hidden="true"></span>' : "") +
      `</button></li>`
    );
  };

  // A bot row. One table decides every part of it (conversation.md, section 20):
  // the avatar's state is the most urgent among the tasks, line two follows it
  // (waiting first), and the unread dot is independent.
  // state: idle, thinking, working, waiting, blocked, failed, done, done-failed, stopped.
  CT.botGroup = ({ bot, state = "idle", preview, time, unread = false, tone = "", open = false, current = false, tasks = "", count = 0, i = 0, id = "" }) => {
    const b = CT.bots[bot];
    const face = state === "done-failed" ? "done" : state;
    const spoken =
      `${b.name}, ${count ? `${count} ${count === 1 ? "task" : "tasks"}, ` : ""}` +
      `${state === "done-failed" ? "done with failures" : stateWord[state]}` +
      (unread ? ", unread" : "");
    return (
      `<li class="bot-group"${open ? ' data-open="true"' : ""}${id ? ` id="${id}"` : ""}>` +
      `<button type="button" class="bot" aria-current="${current}"${tasks ? ` aria-expanded="${open}"` : ""} aria-label="${spoken}">` +
      `${CT.presence(bot, face, { label: false, i, badge: state === "done-failed" ? "failed" : undefined })}` +
      `<span class="bot-text"><span class="bot-line"><span class="bot-name">${b.name}</span><time class="bot-time">${time}</time></span>` +
      `<span class="bot-line"><span class="bot-preview" data-state="${tone || face}">${esc(preview)}</span>` +
      `${unread ? '<span class="unread-dot" aria-hidden="true"></span>' : ""}</span></span></button>` +
      (open && tasks ? `<ul class="task-list" aria-label="${b.name}'s tasks">${tasks}</ul>` : "") +
      `</li>`
    );
  };
})();
