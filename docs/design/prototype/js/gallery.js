// The gallery: every conversation component in every state.
// Each specimen is a name, an optional note, and markup built from components.js.

(function () {
  const CT = window.CT;
  const S = CT.samples;
  const { glyph, presence, statusLine, step, activity, messaged, approval, approvalResolved } = CT;

  const labelled = (items) =>
    `<div class="spec-row">${items.map(([html, label]) => `<figure>${html}<figcaption>${label}</figcaption></figure>`).join("")}</div>`;

  const sized = (px, html) => html.replace('class="presence"', `class="presence" style="--size:${px}px"`);

  // Steps used in several specimens.
  const stepRead = (extra = {}) =>
    step({ kind: "read", title: "Read backup-2026-11-15.log", detail: "214 lines", statusText: "0.6s", ...extra });
  const stepThought = (extra = {}) =>
    step({ kind: "thought", title: "Thought", detail: "71 minutes instead of the usual 23. The transfer line is the odd one…", statusText: "4s", ...extra });
  const stepFailed = (extra = {}) =>
    step({ kind: "read", status: "failed", title: "Couldn't read backup-2026-11-08.log", detail: "No such file", statusText: "Failed", body: S.failedBody(), ...extra });
  const stepList = step({ kind: "list", title: "Looked through logs/archive", detail: "9 files", statusText: "0.2s" });
  const stepRunning = (extra = {}) =>
    step({ kind: "command", status: "running", title: "Running mv", detail: "/srv/media/transcode-cache", statusText: "0:03", ...extra });
  const stepMessage = step({ kind: "message", title: "Messaged Marlow", detail: "replied", statusText: "41s" });
  const stepAgent = step({ kind: "agent", title: "Messaged T3 Code", detail: "accepted, thread 18", statusText: "0.8s" });
  const stepWaiting = step({ kind: "command", status: "waiting", title: "Wants to run mv", detail: "/srv/media/transcode-cache", statusText: "Waiting for you" });
  const stepBlocked = step({
    kind: "command",
    status: "failed",
    title: "Blocked by policy",
    detail: "rm -rf /srv/media/transcode-cache",
    statusText: "Not run",
    open: true,
    body: CT.stepBody({
      readable:
        CT.fields([
          ["Command", "rm -rf /srv/media/transcode-cache", { mono: true }],
          ["Decided by", "Otto's rule: never run rm"],
          ["Source", "Bot rule"],
        ]) + `<p class="exchange-note">The command was not run. A deny always wins over an allow.</p>`,
    }),
  });

  const foot = `<span>scripted/dev-1</span><span>low effort</span><span class="mono">run_7f3a91c2</span>${CT.copyButton("run id")}`;

  const stoppedNote = CT.turnNote({
    lead: glyph("stopped"),
    html:
      "<p><b>Stopped after 40s.</b> Completed steps are not undone.</p>" +
      "<ul><li>Stopped with it: Marlow's run for this message, and one command on media-box.</li>" +
      "<li>Work already sent to T3 Code continues there.</li></ul>",
  });

  const question = {
    title: "How long should I keep the old cache before deleting it?",
    options: [["A week", "Delete it next Monday"], ["A month"], ["Until I say so", "Keep it and remind me"], ["Delete it now"]],
  };

  const sections = [
    {
      id: "presence",
      title: "The state avatar",
      note: "The face, the ring and the badge say the same thing three ways. Characters move their eyes and body; a bot with its own picture relies on the ring and the badge.",
      specimens: [
        {
          name: "Every state",
          html: labelled(
            ["idle", "thinking", "working", "waiting", "blocked", "done", "failed", "stopped"].map((s, i) => [
              presence(["otto", "juniper", "marlow", "pip"][i % 4], s, { i }),
              s === "waiting" ? "waiting on you" : s,
            ]),
          ),
        },
        {
          name: "Waiting while the machine is unreachable",
          note: "Waiting wins, and takes the warning badge from blocked.",
          html: labelled([[presence("otto", "waiting", { badge: "blocked" }), "waiting, machine offline"]]),
        },
        {
          name: "Sizes",
          html: labelled([
            [sized(88, presence("pip", "working")), "88 Work pane"],
            [sized(56, presence("pip", "working")), "56 pinned"],
            [sized(40, presence("pip", "working")), "40 rail"],
            [sized(28, presence("pip", "working")), "28 status line"],
            [sized(22, presence("pip", "working", { size: "sm" })), "22 title pill"],
          ]),
        },
        {
          name: "State marks",
          note: "12 px. Used in task rows, state words and as the avatar's badge.",
          html: labelled(
            ["working", "sending", "waiting", "blocked", "failed", "stopped", "done", "check", "unread", "queued"].map((s) => [
              glyph(s),
              s,
            ]),
          ),
        },
      ],
    },
    {
      id: "status",
      title: "The status line",
      note: "The last thing in a running turn: the avatar and one phrase. It stays put while everything else arrives above it, and leaves only when the run ends.",
      specimens: [
        { name: "First second", note: "The avatar appears at once. The phrase follows within a second.", html: statusLine({ bot: "otto", state: "thinking" }) },
        { name: "Thinking", html: statusLine({ bot: "otto", state: "thinking", phrase: "Thinking", elapsed: "0:02" }) },
        { name: "A step is running", html: statusLine({ bot: "otto", state: "working", phrase: "Reading backup-2026-11-15.log", elapsed: "0:07" }) },
        {
          name: "A long phrase truncates",
          note: "The full phrase is the tooltip on desktop.",
          html: `<div style="max-width:340px">${statusLine({ bot: "otto", state: "working", phrase: "Searching for the weekly backup profile across every archived log", elapsed: "0:31" })}</div>`,
        },
        { name: "Waiting for you", html: statusLine({ bot: "otto", state: "waiting", phrase: "Waiting for you", elapsed: "0:48" }) },
        { name: "Stopping", html: statusLine({ bot: "otto", state: "stopping", phrase: "Stopping…" }) },
        { name: "Blocked", html: statusLine({ bot: "otto", state: "blocked", phrase: "Can't reach media-box" }) },
        { name: "Rate limited", html: statusLine({ bot: "otto", state: "thinking", phrase: "Rate limited. Retrying, attempt 2 of 5", elapsed: "1:12" }) },
        {
          name: "Connection lost mid-run",
          note: "Nothing animates while the client cannot see the run.",
          html: statusLine({ bot: "otto", state: "blocked", phrase: "Reconnecting. Last seen reading the backup log" }),
        },
      ],
    },
    {
      id: "streaming",
      title: "Streaming text and message captions",
      specimens: [
        {
          name: "A reply streaming",
          html: CT.msg({ md: true, streaming: true, html: "<p>Found it. The transcode cache was swept into the backup: 182 GB that is" }),
        },
        {
          name: "Cut off by a stop or a failure",
          html:
            CT.msg({ md: true, html: "<p>Found it. The transcode cache was swept into the backup: 182 GB that is</p>" }) +
            CT.caption("<span>Incomplete</span>"),
        },
        {
          name: "Steer",
          html: CT.msg({ role: "user", html: "Skip the write-up, just fix it." }) + CT.caption("<span>Steer</span>"),
        },
        {
          name: "Failed to send",
          html:
            CT.msg({ role: "user", html: "Is the disk still at 61%?" }) +
            CT.caption(`<span>Failed to send</span>${CT.linkButton("Resend")}${CT.linkButton("Delete", { tone: "muted" })}`, "danger"),
        },
        {
          name: "Written while offline",
          html: CT.msg({ role: "user", pending: "queued", html: "Is the disk still at 61%?" }) + CT.caption("<span>Sends when reconnected</span>"),
        },
      ],
    },
    {
      id: "activity",
      title: "The activity block and its steps",
      note: "Folded, it is one quiet line. Open, the line heads a card of steps. Each step opens by itself to a readable view and to what the gateway sent.",
      specimens: [
        { name: "Folded, running", html: activity({ state: "running", label: "Working", count: "3 steps" }) },
        { name: "Folded, finished", html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps" }) },
        {
          name: "Folded, finished with a failed step",
          note: "A failed step never hides behind the summary.",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", failed: 1, failedSteps: stepFailed({ body: S.failedBody() }) }),
        },
        { name: "Folded, stopped", html: activity({ state: "stopped", label: "Stopped after 40s", count: "4 steps" }) },
        { name: "Folded, failed", html: activity({ state: "failed", label: "Failed after 12s", count: "2 steps", failed: 1, failedSteps: stepFailed() }) },
        { name: "Only reasoning", html: activity({ state: "completed", label: "Thought for 8s" }) },
        {
          name: "Open, running",
          html: activity({
            state: "running",
            label: "Working",
            count: "6 steps",
            failed: 1,
            open: true,
            steps: stepRead() + stepThought() + stepFailed({ body: S.failedBody() }) + stepList + stepWaiting + stepRunning(),
          }),
        },
        {
          name: "A step open: readable",
          note: "Long output shows eight lines until asked for the rest.",
          html: activity({ state: "running", label: "Working", count: "3 steps", open: true, steps: stepRead({ open: true, body: S.readBody() }) + stepThought() + stepRunning() }),
        },
        {
          name: "A step open: raw",
          note: "The exact tool name, arguments, result, timing and identifiers. Each value can be copied.",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", open: true, steps: stepRead({ open: true, body: S.readBody("raw") }), foot }),
        },
        {
          name: "A running step open",
          note: "Output appears as the gateway streams it.",
          html: activity({ state: "running", label: "Working", count: "8 steps", open: true, steps: stepRunning({ open: true, body: S.commandBody(true) }) }),
        },
        {
          name: "A thought open, and its raw event",
          html: activity({
            state: "completed",
            label: "Thought for 8s",
            open: true,
            steps: stepThought({ open: true, body: S.thoughtBody() }) + stepThought({ open: true, body: S.thoughtBody("raw") }),
          }),
        },
        {
          name: "A failed step open",
          html: activity({ state: "running", label: "Working", count: "3 steps", failed: 1, open: true, steps: stepFailed({ open: true, body: S.failedBody() }) }),
        },
        {
          name: "Blocked by policy",
          note: "A denied call never runs. The step names the rule that decided.",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", failed: 1, open: true, steps: stepBlocked }),
        },
        {
          name: "Messages and handoffs as steps",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", open: true, steps: stepMessage + stepAgent }),
        },
      ],
    },
    {
      id: "messaged",
      title: "The Messaged card",
      note: "One card per message sent to another bot. One line folded; what was sent and what came back when open.",
      specimens: [
        {
          name: "Folded, every state",
          html: [
            "sending", "approval", "sent", "working", "recipient-waiting", "no-reply", "unknown",
            "replied", "failed", "blocked", "not-sent", "recipient-stopped",
          ]
            .map((state) => messaged({ target: "marlow", first: "Write a two-line entry for the house log.", state }))
            .join(""),
        },
        { name: "Open, the recipient is working", note: "The reply slot shows the recipient's live status line.", html: messaged({ target: "marlow", first: "Write a two-line entry for the house log.", state: "working", open: true, body: S.marlowBody("working") }) },
        { name: "Open, replied", html: messaged({ target: "marlow", first: "Write a two-line entry for the house log.", state: "replied", open: true, body: S.marlowBody("replied") }) },
        { name: "Open, failed", html: messaged({ target: "marlow", first: "Write a two-line entry for the house log.", state: "failed", open: true, body: S.marlowBody("failed") }) },
        {
          name: "The receiving side, every state",
          note: "In the recipient's task, at the start of the run the message started. Its state is the recipient's own run.",
          html: ["working", "waiting-you", "replied", "completed", "failed", "stopped"]
            .map((state) => messaged({ target: "otto", verb: "Message from", first: "Write a two-line entry for the house log.", state }))
            .join(""),
        },
        {
          name: "Messages the bot did not ask for",
          html:
            CT.eventLine(`Message from ${CT.avatar("pip")}<b>Pip</b>`) +
            CT.eventLine(`2 messages with ${CT.avatar("otto")}<b>Otto</b>`),
        },
      ],
    },
    {
      id: "t3code",
      title: "The Messaged T3 Code card",
      note: "The same component. It is drawn only from the bot's own tool events; the app never talks to T3 Code. A link or a file shows only when the tool result carries one.",
      specimens: [
        {
          name: "Folded, every state",
          html: ["sending", "sent", "delivery-unknown", "done", "failed", "not-sent"]
            .map((state) => messaged({ target: "t3code", first: "In backup-scripts, add /srv/media/transcode-cache to the exclude list.", state }))
            .join(""),
        },
        { name: "Open, sent", html: messaged({ target: "t3code", first: "In backup-scripts, add the cache to the exclude list.", state: "sent", open: true, body: S.t3Body("sent") }) },
        { name: "Open, sent, and the bot was stopped", html: messaged({ target: "t3code", first: "In backup-scripts, add the cache to the exclude list.", state: "sent", open: true, body: S.t3Body("sent", { stopped: true }) }) },
        { name: "Open, done, with files and a link", html: messaged({ target: "t3code", first: "In backup-scripts, add the cache to the exclude list.", state: "done", open: true, body: S.t3Body("done") }) },
        { name: "Open, failed", html: messaged({ target: "t3code", first: "In backup-scripts, add the cache to the exclude list.", state: "failed", open: true, body: S.t3Body("failed") }) },
      ],
    },
    {
      id: "approval",
      title: "Approval cards",
      note: "Deny is always offered. A standing allow shows its rule, who it covers and when it ends before it is saved.",
      specimens: [
        { name: "Pending", html: approval(S.approval) },
        { name: "Pending, full request open", html: approval({ ...S.approval, full: { ...S.approval.full, open: true } }) },
        { name: "Always allow: scope and duration", html: approval({ ...S.approval, standingOpen: true }) },
        {
          name: "With warnings and an expiry",
          html: approval({
            ...S.approval,
            summary: "Delete the old transcode cache on <b>media-box</b>. This frees 182 GB.",
            warnings: ["This can't be undone"],
            full: { ...S.approval.full, command: "rm -rf /srv/media/transcode-cache.old" },
            foot: "Asked by the routine <b>Weekly cleanup</b>. Expires in 28 minutes; the command is not run if it does.",
          }),
        },
        { name: "No rule to offer", note: "When the gateway offers no standing rule, the choice is Allow or Deny.", html: approval({ ...S.approval, standing: null, noRule: true }) },
        {
          name: "Asking to message another bot",
          html: approval({
            bot: "otto",
            what: "message Marlow",
            summary: "“Write a two-line entry for the house log…”",
            full: { reason: "Otto's outgoing messages are set to ask first.", command: S.marlowSent, fields: [["To", "Marlow"], ["Asked by", "Your message in this task, 5:24 PM"]] },
            standing: { rule: "Messages from Otto to Marlow" },
          }),
        },
        {
          name: "Resolved, every outcome",
          html: [
            ["once", "Move the transcode cache aside on media-box"],
            ["always", "Move the transcode cache aside on media-box"],
            ["denied", "Move the transcode cache aside on media-box"],
            ["expired", "Delete the old transcode cache on media-box"],
            ["closed-message", "Move the transcode cache aside on media-box"],
            ["closed-ended", "Move the transcode cache aside on media-box"],
            ["closed-failed", "Move the transcode cache aside on media-box"],
            ["cancelled", "Move the transcode cache aside on media-box"],
          ]
            .map(([state, line]) => approvalResolved({ state, line, when: "5:25 PM", full: S.approval.full }))
            .join(""),
        },
        {
          name: "Resolved and open: always allowed",
          html: approvalResolved({
            state: "always",
            line: "Move the transcode cache aside on media-box",
            when: "5:25 PM",
            open: true,
            outcome: "Otto ran this, and can run it again without asking until tomorrow, 5:25 PM.",
            rule: `<p class="request-rule"><code class="tool-name">/bin/mv, any arguments, on media-box</code><span>Otto only</span>${CT.linkButton("Revoke")}</p>`,
            full: S.approval.full,
          }),
        },
        {
          name: "Resolved and open: denied",
          html: approvalResolved({ state: "denied", line: "Move the transcode cache aside on media-box", when: "5:25 PM", open: true, outcome: "Otto won't do this, and won't ask again until you send another message.", full: S.approval.full }),
        },
      ],
    },
    {
      id: "question",
      title: "Question cards",
      specimens: [
        { name: "Pending, one answer", html: CT.question(question) },
        { name: "Pending, several answers", html: CT.question({ title: "Which folders should the backup skip?", multi: true, picked: [0, 2], options: [["Transcode cache"], ["Downloads in progress"], ["Thumbnails"], ["Trash"]] }) },
        { name: "Pending, with a typed answer", html: CT.question({ ...question, own: "Two weeks, then ask me" }) },
        { name: "Answered", html: CT.questionAnswered({ title: question.title, answers: [["A", "A week"]] }) },
        { name: "Answered, several", html: CT.questionAnswered({ title: "Which folders should the backup skip?", answers: [["A", "Transcode cache"], ["C", "Thumbnails"]] }) },
        { name: "Answered in your own words", html: CT.questionAnswered({ title: question.title, answers: [["", "Two weeks, then ask me"]] }) },
        { name: "Dismissed", html: CT.questionAnswered({ title: question.title, state: "dismissed", answers: [["", "Dismissed"]] }) },
        { name: "Closed because the run ended", html: CT.questionAnswered({ title: question.title, state: "closed", answers: [["", "Closed: the run ended"]] }) },
      ],
    },
    {
      id: "composer",
      title: "The composer during a run",
      note: "Send stays. Stop appears beside it for as long as the run can be stopped. Queued messages wait on a shelf above the pill.",
      specimens: [
        { name: "No run, empty", html: CT.composer({ bot: "otto" }) },
        { name: "No run, with text", html: CT.composer({ bot: "otto", text: "Find out why it was slow." }) },
        { name: "Running, empty", html: CT.composer({ bot: "otto", run: "running" }) },
        { name: "Running, with text: Enter steers", html: CT.composer({ bot: "otto", run: "running", text: "Skip the write-up, just fix it." }) },
        { name: "Choosing how to send", html: `<div style="padding-top:132px">${CT.composer({ bot: "otto", run: "running", text: "Then check the certificate warning too.", menu: true })}</div>` },
        { name: "Running, set to queue", html: CT.composer({ bot: "otto", run: "running", text: "Then check the certificate warning too.", mode: "queue" }) },
        {
          name: "A queued message",
          html: CT.composer({
            bot: "otto",
            run: "running",
            shelf: CT.shelfRow({ lead: glyph("queued"), text: "<b>Queued</b> <span>Then check the certificate warning too.</span>", actions: CT.button("Send now") + CT.button("Cancel", 'data-variant="quiet"') }),
          }),
        },
        {
          name: "Waiting on you",
          note: "The shelf names what is waiting and takes you to it.",
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            shelf: CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto needs your approval</b> <span>to run a command</span>", actions: CT.button("Review") }),
          }),
        },
        {
          name: "Waiting on you, while typing",
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            text: "Use a different folder name.",
            shelf: CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Sending will close Otto's approval request</b>", actions: CT.button("Review") }),
          }),
        },
        {
          name: "A queued message that couldn't start",
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Couldn't start</b> <span>Otto's daily budget is used up. Then check the certificate warning too.</span>", actions: CT.button("Delete", 'data-variant="quiet"') }),
          }),
        },
        { name: "Stopping", note: "A message sent now is queued.", html: CT.composer({ bot: "otto", run: "stopping", text: "" }) },
        {
          name: "Stopping, with a message queued",
          note: "Send now is unavailable until the run has ended.",
          html: CT.composer({
            bot: "otto",
            run: "stopping",
            shelf: CT.shelfRow({ lead: glyph("queued"), text: "<b>Queued</b> <span>Then check the certificate warning too.</span>", actions: CT.button("Cancel", 'data-variant="quiet"') }),
          }),
        },
        { name: "Offline", html: CT.composer({ bot: "otto", run: "offline", text: "Is the disk still at 61%?" }) },
        {
          name: "A notice",
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Otto failed to respond</b> <span>The model provider is overloaded.</span>", actions: CT.button("Try again") + `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss">${CT.icon("x")}</button>` }),
          }),
        },
      ],
    },
    {
      id: "jump",
      title: "Jump to latest and the connection strip",
      note: "New output is followed only when the reader is near the bottom. Otherwise the position holds and this control appears above the composer.",
      specimens: [
        {
          name: "Jump to latest, every state",
          html: `<div class="spec-row" style="gap:28px 16px">${[
            CT.jump({ state: "latest" }),
            CT.jump({ state: "latest", phrase: "3 new" }),
            CT.jump({ state: "live", bot: "otto", phrase: "Reading the backup log" }),
            CT.jump({ state: "needs-you", phrase: "Needs you" }),
            CT.jump({ state: "needs-you", phrase: "Needs you", up: true }),
          ]
            .map((html) => `<span class="spec-static">${html}</span>`)
            .join("")}</div>`,
        },
        {
          name: "The connection strip, every state",
          note: "After a reconnect that missed events, the strip says it caught up. Nothing in the conversation unmounts or folds.",
          html: `<div class="spec-row" style="gap:12px">${["reconnecting", "offline", "syncing", "synced", "failed"].map((b) => `<span class="spec-static">${CT.banner(b)}</span>`).join("")}</div>`,
        },
      ],
    },
    {
      id: "errors",
      title: "Turn errors and notes",
      specimens: [
        {
          name: "A turn failed",
          html: CT.turnError({
            title: "Otto couldn't finish this turn",
            reason: "The model provider is overloaded. Nothing ran after step 4, and steps already completed are not undone.",
            actions: CT.button("Try again") + CT.linkButton("Copy request ID", { tone: "muted" }) + CT.linkButton("Raw", { tone: "muted" }),
          }),
        },
        {
          name: "Rate limited",
          html: CT.turnError({ title: "Otto couldn't finish this turn", reason: "This request was rate limited after 5 attempts. Try again in a moment.", actions: CT.button("Try again") + CT.linkButton("Copy request ID", { tone: "muted" }) }),
        },
        { name: "Stopped", html: stoppedNote },
        { name: "Finished before Stop took effect", html: CT.turnNote({ lead: glyph("check"), html: "<p><b>Finished before Stop took effect.</b> The turn completed normally.</p>" }) },
        { name: "Turn time limit", html: CT.turnNote({ lead: CT.icon("clock"), html: "<p><b>Stopped at the 50 minute turn limit</b> so it would not hang. Send a message to pick up where it left off.</p>" }) },
        { name: "Three tool calls timed out", html: CT.turnNote({ lead: CT.icon("warning"), html: "<p><b>Stopped after 3 tool calls in a row timed out.</b> media-box may not be responding.</p>" }) },
      ],
    },
    {
      id: "rows",
      title: "Rows in the rail",
      note: "A bot row shows the most urgent state among its tasks. A task row is its title and one mark.",
      specimens: [
        {
          name: "Bot rows",
          rail: true,
          html: `<ul class="bot-list">${[
            { bot: "juniper", state: "idle", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM" },
            { bot: "otto", state: "working", preview: "Reading backup-2026-11-15.log", time: "now" },
            { bot: "marlow", state: "thinking", preview: "Thinking", time: "now" },
            { bot: "pip", state: "waiting", preview: "Waiting for you: a question", time: "2m" },
            { bot: "otto", state: "blocked", preview: "Can't reach media-box", time: "4m" },
            { bot: "marlow", state: "failed", preview: "Couldn't finish: provider overloaded", time: "9m" },
            { bot: "juniper", state: "done", preview: "Verdict: usually worth it.", time: "5:02 PM", mark: "unread" },
            { bot: "pip", state: "done", preview: "Finished with 1 failed step", time: "4:40 PM", mark: "failed" },
          ]
            .map((row, i) => CT.botGroup({ ...row, i }))
            .join("")}</ul>`,
        },
        {
          name: "Task rows",
          rail: true,
          html: `<ul class="bot-list">${CT.botGroup({
            bot: "otto",
            state: "waiting",
            preview: "Waiting for you: approve a command",
            time: "now",
            open: true,
            tasks:
              [
                ["Weekly backup check", "waiting", true],
                ["Disk almost full on the media box", "running"],
                ["Certificate renewal warning", "unread"],
                ["Router firmware", "done-failed"],
                ["Printer offline again", "failed"],
                ["NAS scrub", "blocked"],
                ["Rotate the logs", "queued"],
                ["Old tickets", "idle"],
              ]
                .map(([title, status, current]) => CT.taskRow({ title, status, current }))
                .join("") +
              `<li><button type="button" class="task task-new">${CT.icon("plus")}<span class="task-title">New task</span></button></li>`,
          })}</ul>`,
        },
      ],
    },
    {
      id: "phone",
      title: "Touch equivalents",
      note: "Wherever the desktop uses hover or a right-click, the phone uses a tap or touch and hold.",
      specimens: [
        {
          name: "Touch and hold on a step",
          html: `<div class="sheet" style="max-width:390px"><ul class="menu" role="menu"><li><button type="button" class="menu-item" role="menuitem">${CT.icon("copy")}Copy result</button></li><li><button type="button" class="menu-item" role="menuitem">${CT.icon("code")}Copy raw</button></li></ul></div>`,
        },
        {
          name: "Touch and hold on Send, during a run",
          html: `<div class="sheet" style="max-width:390px"><ul class="menu" role="menu"><li><button type="button" class="menu-item" role="menuitem">${CT.icon("arrow-up")}Steer this turn</button></li><li><button type="button" class="menu-item" role="menuitem">${CT.icon("queue")}Queue after this turn</button></li><li><button type="button" class="menu-item" role="menuitem">${CT.icon("new-task")}Start as new task</button></li></ul></div>`,
        },
      ],
    },
  ];

  const only = CT.params.get("section");
  const root = document.getElementById("gallery");
  root.innerHTML = sections
    .filter((section) => !only || section.id === only)
    .map(
      (section) =>
        `<section class="spec-section" id="${section.id}"><header><h2>${section.title}</h2>` +
        `${section.note ? `<p>${section.note}</p>` : ""}</header>` +
        section.specimens
          .map(
            (spec) =>
              `<article class="spec"><div class="spec-label"><h3>${spec.name}</h3>${spec.note ? `<p>${spec.note}</p>` : ""}</div>` +
              `<div class="spec-box${spec.rail ? " spec-rail" : ""}">${spec.html}</div></article>`,
          )
          .join("") +
        `</section>`,
    )
    .join("");

  const nav = document.getElementById("gallery-nav");
  if (nav) nav.innerHTML = sections.map((section) => `<a href="#${section.id}">${section.title}</a>`).join("");
})();
