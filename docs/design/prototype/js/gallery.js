// The gallery: every conversation component in every state.
// Each specimen is a name, an optional note, and markup built from components.js.
// Cards and steps work here as they do in the app: they open, Raw opens, copy
// copies, approvals and questions resolve. A specimen marked `still` is a
// picture of a state whose controls belong to the running conversation; it is
// inert here and works in conversation.html.

(function () {
  const CT = window.CT;
  const S = CT.samples;
  const { glyph, presence, statusLine, step, activity, messaged, approval, approvalResolved } = CT;

  const labelled = (items) =>
    `<div class="spec-row">${items.map(([html, label]) => `<figure>${html}<figcaption>${label}</figcaption></figure>`).join("")}</div>`;

  const sized = (px, html) => html.replace('class="presence"', `class="presence" style="--size:${px}px"`);
  const eight = ["idle", "thinking", "working", "waiting", "blocked", "done", "failed", "stopped"];

  // Steps used in several specimens.
  const stepRead = (extra = {}) =>
    step({ kind: "read", title: "Read backup-2026-11-15.log", detail: `${S.logLines} lines`, statusText: "0.6s", body: S.readBody(), ...extra });
  const stepThought = (extra = {}) =>
    step({ kind: "thought", title: "Thought", detail: "71 minutes instead of the usual 23. The transfer line is the odd one…", statusText: "4s", body: S.thoughtBody(), ...extra });
  const stepFailed = (extra = {}) =>
    step({ kind: "read", status: "failed", title: "Couldn't read backup-2026-11-08.log", detail: "No such file", statusText: "Failed", body: S.failedBody(), ...extra });
  const stepList = (extra = {}) => step({ kind: "list", title: "Looked through logs/archive", detail: "9 files", statusText: "0.2s", body: S.listBody(), ...extra });
  const stepWrite = (extra = {}) => step({ kind: "write", title: "Wrote house-log.md", detail: "+4 lines", statusText: "0.3s", body: S.writeBody(), ...extra });
  const stepRunning = (extra = {}) =>
    step({ kind: "command", status: "running", title: "Running du", detail: "/srv/media/*", statusText: "0:03", body: S.liveBody(), ...extra });
  const stepMessage = (extra = {}) => step({ kind: "message", title: "Messaged Marlow", detail: "replied", statusText: "41s", body: S.messageStepBody("replied"), ...extra });
  const stepAgent = (extra = {}) => step({ kind: "agent", title: "Called T3 Code", detail: "call made", statusText: "0.8s", body: S.agentStepBody("call-made"), ...extra });
  const stepWaiting = step({ kind: "command", status: "waiting", title: "Wants to run mv", detail: "/srv/media/transcode-cache", statusText: "Waiting for you", body: S.commandBody("waiting") });
  const stepBlocked = (source, extra = {}) =>
    step({
      kind: "command",
      status: "failed",
      title: source === "review" ? "Blocked by review" : "Blocked by policy",
      detail: "rm -rf /srv/media/transcode-cache",
      statusText: "Not run",
      body: S.blockedBody(source),
      ...extra,
    });

  const foot = CT.activityFoot({ model: "scripted/dev-1", effort: "low", run: "run_7f3a91c2" });
  const first = S.marlowFirst;

  const stoppedNote = CT.turnNote({
    lead: glyph("stopped"),
    html:
      "<p><b>Stopped after 40s.</b> Completed steps are not undone.</p>" +
      "<ul><li>Stopped with it: Marlow's run for this message.</li>" +
      "<li>The call to T3 Code was made. Work handed to T3 Code may continue there.</li></ul>",
  });

  const question = S.question;
  const skip = { title: "Which folders should the backup skip?", multi: true, options: [["Transcode cache"], ["Downloads in progress"], ["Thumbnails"], ["Trash"]] };

  // An approval for each variant, from the same request.
  const withDays = { ...S.approval.rule, where: "The gateway", days: true };
  const stillAsks = { ...S.approval.rule, stillAsks: "Otto is set to always ask on media-box, so you will still be asked each time. The rule takes effect if that setting changes." };

  const shelf = (rows) => rows.join("");
  const queuedRow = (kind = "Queued", actions = CT.button("Send now") + CT.button("Cancel", 'data-variant="quiet"')) =>
    CT.shelfRow({ lead: glyph("queued"), text: `<b>${kind}</b> <span>Then check the certificate warning too.</span>`, actions });

  const sections = [
    {
      id: "access",
      title: "What the connection may do",
      note: "A read-only connection follows the work and is not sent approvals or questions. The access bar stands in the composer's place and asks once for the tier that can send, stop and answer.",
      specimens: [
        { name: "Read-only", still: true, html: CT.accessBar({ bot: "otto", state: "read" }) },
        { name: "Asking the gateway", still: true, html: CT.accessBar({ bot: "otto", state: "asking" }) },
        {
          name: "Requested: waiting for the gateway's owner",
          note: "The command and the request id come from the host. Both can be copied.",
          still: true,
          html: CT.accessBar({ bot: "otto", state: "requested" }),
        },
        { name: "Denied", still: true, html: CT.accessBar({ bot: "otto", state: "denied" }) },
        { name: "Expired", still: true, html: CT.accessBar({ bot: "otto", state: "expired" }) },
        { name: "Couldn't ask", still: true, html: CT.accessBar({ bot: "otto", state: "failed", reason: "The gateway did not answer." }) },
        { name: "A gateway with no way to step up", still: true, html: CT.accessBar({ bot: "otto", state: "none" }) },
        {
          name: "Access granted",
          note: "The composer takes the bar's place and the strip says so for four seconds.",
          still: true,
          html: `<span class="spec-static">${CT.banner("granted")}</span><div style="height:12px"></div>${CT.composer({ bot: "otto", run: "running" })}`,
        },
        {
          name: "A wait this device cannot see",
          note: "Shown only when the gateway reports the wait to a read-only connection.",
          still: true,
          html:
            `<div class="turn-note">${glyph("blocked")}<div><p><b>Otto is waiting for an approval or an answer.</b> This device can't see it on a read-only connection.</p>` +
            `<p>${CT.linkButton("Request access")}</p></div></div>` +
            statusLine({ bot: "otto", state: "thinking", badge: "blocked", phrase: "Waiting for an answer", elapsed: "0:48" }),
        },
        {
          name: "A request this device can read but not answer",
          note: "The full request and Raw still open.",
          html: approval({ ...S.approval, readonly: true }),
        },
      ],
    },
    {
      id: "presence",
      title: "The state avatar",
      note: "The face, the ring and the badge say the same thing three ways. Characters move their eyes and body; a bot with its own picture relies on the ring and the badge.",
      specimens: [
        {
          name: "Every state",
          html: labelled(eight.map((s, i) => [presence(["otto", "juniper", "marlow", "pip"][i % 4], s, { i }), s === "waiting" ? "waiting for you" : s])),
        },
        {
          name: "A bot with its own picture, every state",
          note: "No face to move: thinking is a ring that breathes, working is the orbit, and the badge carries the rest. Done has neither; the row's unread dot tells it from idle.",
          html: labelled(eight.map((s) => [presence("otto", s, { image: true }), s === "waiting" ? "waiting for you" : s])),
        },
        {
          name: "Waiting while the machine is unreachable",
          note: "Waiting wins, and takes the warning badge from blocked.",
          html: labelled([[presence("otto", "waiting", { badge: "blocked" }), "waiting, machine offline"]]),
        },
        {
          name: "Done with failures",
          note: "The done face with the failed badge.",
          html: labelled([[presence("pip", "done", { badge: "failed" }), "done with failures"]]),
        },
        {
          name: "Sizes",
          html: labelled([
            [sized(64, presence("pip", "working")), "64 Work pane"],
            [sized(56, presence("pip", "working")), "56 pinned"],
            [sized(40, presence("pip", "working")), "40 rail"],
            [sized(28, presence("pip", "working")), "28 status line"],
            [sized(22, presence("pip", "working", { size: "sm" })), "22 title pill"],
          ]),
        },
        {
          name: "State marks",
          note: "12 px. Used in task rows, state words and as the avatar's badge. The hollow ring always has a word beside it.",
          html: labelled(["working", "sending", "waiting", "blocked", "failed", "stopped", "done", "check", "unread", "queued"].map((s) => [glyph(s), s === "queued" ? "queued, unknown" : s])),
        },
      ],
    },
    {
      id: "status",
      title: "The status line",
      note: "The last thing in a running turn: the avatar and one phrase. It stays put while everything else arrives above it, and leaves only when the run ends.",
      specimens: [
        { name: "The moment you send", note: "The avatar and the word Thinking appear together. The phrase is never empty.", html: statusLine({ bot: "otto", state: "thinking", phrase: "Thinking", elapsed: "0:00", steps: false }) },
        { name: "A step is running", html: statusLine({ bot: "otto", state: "working", phrase: "Reading backup-2026-11-15.log", elapsed: "0:07" }) },
        {
          name: "A long phrase truncates",
          note: "The full phrase is the tooltip on desktop.",
          html: `<div style="max-width:340px">${statusLine({ bot: "otto", state: "working", phrase: "Searching for the weekly backup profile across every archived log", elapsed: "0:31" })}</div>`,
        },
        { name: "The gateway is reviewing a command", html: statusLine({ bot: "otto", state: "working", phrase: "Reviewing a command", elapsed: "0:52" }) },
        { name: "Waiting for another bot", html: statusLine({ bot: "otto", state: "working", phrase: "Waiting for Marlow", elapsed: "0:40" }) },
        { name: "Setting up", note: "From the gateway's own status phases.", html: statusLine({ bot: "otto", state: "thinking", phrase: "Setting up the workspace", elapsed: "0:03" }) },
        { name: "Gathering context", html: statusLine({ bot: "otto", state: "thinking", phrase: "Gathering context", elapsed: "0:05" }) },
        { name: "Waiting for you", html: statusLine({ bot: "otto", state: "waiting", phrase: "Waiting for you", elapsed: "0:48" }) },
        { name: "Stopping", html: statusLine({ bot: "otto", state: "stopping", phrase: "Stopping…" }) },
        { name: "Blocked", html: statusLine({ bot: "otto", state: "blocked", phrase: "Can't reach media-box" }) },
        { name: "Rate limited", html: statusLine({ bot: "otto", state: "thinking", phrase: "Rate limited. Retrying, attempt 2 of 5", elapsed: "1:12" }) },
        {
          name: "Connection lost mid-run",
          note: "Nothing animates while the client cannot see the run, and the elapsed time is hidden.",
          lost: true,
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
        { name: "Steer", html: CT.msg({ role: "user", html: "Skip the write-up, just fix it." }) + CT.caption("<span>Steer</span>") },
        {
          name: "A steer the gateway turned into a restart",
          note: "Only when the gateway reports the restart.",
          html: CT.msg({ role: "user", html: "Skip the write-up, just fix it." }) + CT.caption("<span>Steer · restarted the turn</span>"),
        },
        {
          name: "Failed to send",
          still: true,
          html:
            CT.msg({ role: "user", html: "Is the disk still at 61%?" }) +
            CT.caption(`<span>Failed to send</span>${CT.linkButton("Resend")}${CT.linkButton("Delete", { tone: "muted" })}`, "danger"),
        },
        {
          name: "Written while offline",
          note: "Not sent yet, so not yet in your colour. The text keeps full contrast.",
          html: CT.msg({ role: "user", pending: "held", html: "Is the disk still at 61%?" }) + CT.caption("<span>Sends when reconnected</span>"),
        },
      ],
    },
    {
      id: "activity",
      title: "The activity block and its steps",
      note: "Folded, it is one quiet line. Open, the line heads a card of steps. Every step, of every kind, opens to a readable view and to what the gateway sent.",
      specimens: [
        { name: "Folded, running", html: activity({ state: "running", label: "Working", count: "3 steps", steps: stepRead() + stepThought() + stepRunning() }) },
        { name: "Folded, finished", html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", steps: stepRead() + stepThought() + stepList() + stepMessage() + stepAgent() + stepWrite(), foot }) },
        {
          name: "Folded, finished with a failed step",
          note: "A failed step never hides behind the summary.",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", failed: 1, steps: stepRead() + stepFailed(), failedSteps: stepFailed() }),
        },
        { name: "Folded, stopped", html: activity({ state: "stopped", label: "Stopped after 40s", count: "4 steps", steps: stepRead() + stepThought() }) },
        { name: "Folded, failed", html: activity({ state: "failed", label: "Failed after 12s", count: "2 steps", failed: 1, steps: stepRead() + stepFailed(), failedSteps: stepFailed() }) },
        { name: "Only reasoning", note: "A run with reasoning and no tool call still has steps.", html: activity({ state: "completed", label: "Thought for 8s", steps: stepThought() }) },
        {
          name: "The connection is lost mid-run",
          lost: true,
          html: activity({
            state: "running",
            label: "Last seen working",
            count: "3 steps",
            open: true,
            steps: stepRead() + stepThought() + step({ kind: "command", status: "running", title: "Running du", detail: "/srv/media/*", statusText: "Last seen running", body: S.liveBody() }),
          }),
        },
        {
          name: "Open, running",
          html: activity({ state: "running", label: "Working", count: "6 steps", failed: 1, open: true, steps: stepRead() + stepThought() + stepFailed() + stepList() + stepWaiting + stepRunning(), foot }),
        },
        {
          name: "A step open: readable",
          note: "Long output shows eight whole lines, then the real count. Nothing is half faded.",
          html: activity({ state: "running", label: "Working", count: "3 steps", open: true, steps: stepRead({ open: true }) + stepThought() + stepRunning() }),
        },
        {
          name: "A step open: raw",
          note: "The exact tool name, arguments, result, timing and identifiers. Each value has its own copy button, named for what it copies.",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", open: true, steps: stepRead({ open: true, body: S.readBody("raw") }), foot }),
        },
        {
          name: "A running step open",
          note: "Output appears as the gateway streams it.",
          html: activity({ state: "running", label: "Working", count: "8 steps", open: true, steps: stepRunning({ open: true }) }),
        },
        {
          name: "A thought open, and its raw event",
          html: activity({ state: "completed", label: "Thought for 8s", open: true, steps: stepThought({ open: true }) + stepThought({ open: true, body: S.thoughtBody("raw") }) }),
        },
        { name: "A failed step open", html: activity({ state: "running", label: "Working", count: "3 steps", failed: 1, open: true, steps: stepFailed({ open: true }) }) },
        {
          name: "A folder listing and a file edit, open",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", open: true, steps: stepList({ open: true }) + stepWrite({ open: true }) }),
        },
        {
          name: "A message and a handoff as steps, open",
          note: "The step shows what was sent and leads to its card. Raw is the same call the card shows.",
          html: activity({ state: "completed", label: "Worked for 1m 12s", count: "9 steps", open: true, steps: stepMessage({ open: true }) + stepAgent({ open: true }) }),
        },
        {
          name: "A command that exited with a non-zero code",
          note: "Not a failed step. The code is shown plainly.",
          html: activity({
            state: "completed",
            label: "Worked for 22s",
            count: "4 steps",
            open: true,
            steps: step({ kind: "command", title: "Ran grep", detail: "exit 1", statusText: "0.1s", open: true, body: S.exitBody() }),
          }),
        },
        {
          name: "A command that hit its own time limit",
          note: "A failed step of its own kind. The run goes on.",
          html: activity({
            state: "running",
            label: "Working",
            count: "5 steps",
            failed: 1,
            open: true,
            steps: step({ kind: "command", status: "failed", title: "rsync timed out", detail: "its 120s limit", statusText: "Timed out", open: true, body: S.timeoutBody("command") }),
          }),
        },
        {
          name: "A command cut off by the run's time limit",
          html: activity({
            state: "failed",
            label: "Failed after 50m 00s",
            count: "5 steps",
            failed: 1,
            open: true,
            steps: step({ kind: "command", status: "failed", title: "rsync was cut off", detail: "the run's 50m limit", statusText: "Aborted", open: true, body: S.timeoutBody("run") }),
          }),
        },
        {
          name: "Output the gateway cut",
          note: "The gateway sends about 8,000 characters and flags the cut. Copy copies what was received and says so.",
          html: activity({
            state: "completed",
            label: "Worked for 22s",
            count: "4 steps",
            open: true,
            steps:
              step({ kind: "command", title: "Ran journalctl", detail: "exit 0", statusText: "0.9s", open: true, body: S.truncatedBody() }) +
              step({ kind: "command", title: "Ran journalctl", detail: "exit 0", statusText: "0.9s", open: true, body: S.truncatedBody("raw") }),
          }),
        },
        {
          name: "A step whose detail is loading, and one that could not load",
          html: activity({
            state: "completed",
            label: "Worked for 9s",
            count: "2 steps",
            open: true,
            steps:
              step({ kind: "list", title: "Looked through logs", detail: "31 files", statusText: "0.2s", open: true, body: CT.stepBody({ state: "loading" }) }) +
              step({ kind: "read", title: "Read backup-2026-11-15.log", detail: `${S.logLines} lines`, statusText: "0.6s", open: true, body: CT.stepBody({ state: "failed" }) }),
          }),
        },
        {
          name: "Raw that is not available",
          note: "One sentence says why. Nothing is invented to fill it.",
          html: activity({
            state: "completed",
            label: "Worked for 9s",
            count: "2 steps",
            open: true,
            steps:
              step({ kind: "list", title: "Looked through logs", detail: "31 files", open: true, body: CT.stepBody({ view: "raw", readable: CT.note("31 entries."), raw: { state: "unavailable", reason: "This event is older than the history the gateway returned." } }) }) +
              step({ kind: "read", title: "Read notes.md", detail: "12 lines", open: true, body: CT.stepBody({ view: "raw", readable: CT.note("12 lines."), raw: { state: "failed" } }) }),
          }),
        },
        {
          name: "The automatic review: approved",
          note: "Quiet. The row shows nothing extra; the open step has one line.",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", open: true, steps: step({ kind: "command", title: "Ran df", detail: "exit 0", statusText: "0.1s", open: true, body: S.reviewedBody() }) }),
        },
        {
          name: "The automatic review: in progress",
          html: activity({ state: "running", label: "Working", count: "4 steps", open: true, steps: step({ kind: "command", status: "running", title: "Reviewing mv", detail: "/srv/media/transcode-cache", open: true, body: S.commandBody("review") }) }),
        },
      ],
    },
    {
      id: "messaged",
      title: "The Messaged card",
      note: "One card per message sent to another bot. Each state is something an event established. Open any of them: what was sent, what the card can say about the other side, and Raw.",
      specimens: [
        {
          name: "Folded, every state",
          html: Object.keys({ sending: 1, approval: 1, "call-started": 1, sent: 1, working: 1, "recipient-waiting": 1, "no-reply": 1, replied: 1, "recipient-stopped": 1, failed: 1, blocked: 1, "not-sent": 1, unknown: 1 })
            .map((state) => messaged({ target: "marlow", first, state, body: S.marlowBody(state) }))
            .join(""),
        },
        { name: "Open, call started", note: "The call started. That does not show the message was delivered.", html: messaged({ target: "marlow", first, state: "call-started", open: true, body: S.marlowBody("call-started") }) },
        { name: "Open, waiting for approval", html: messaged({ target: "marlow", first, state: "approval", open: true, body: S.marlowBody("approval") }) },
        { name: "Open, sent", html: messaged({ target: "marlow", first, state: "sent", open: true, body: S.marlowBody("sent") }) },
        { name: "Open, the recipient is working", note: "One row for the recipient: its state avatar, its name and its current phrase.", html: messaged({ target: "marlow", first, state: "working", open: true, body: S.marlowBody("working") }) },
        { name: "Open, the recipient is waiting", html: messaged({ target: "marlow", first, state: "recipient-waiting", open: true, body: S.marlowBody("recipient-waiting") }) },
        { name: "Open, no reply yet", html: messaged({ target: "marlow", first, state: "no-reply", open: true, body: S.marlowBody("no-reply") }) },
        { name: "Open, replied", note: "Show full exchange opens every message between the two bots in this task, in place.", html: messaged({ target: "marlow", first, state: "replied", open: true, body: S.marlowBody("replied") }) },
        { name: "Open, the recipient was stopped", html: messaged({ target: "marlow", first, state: "recipient-stopped", open: true, body: S.marlowBody("recipient-stopped") }) },
        { name: "Open, failed", html: messaged({ target: "marlow", first, state: "failed", open: true, body: S.marlowBody("failed") }) },
        { name: "Open, blocked by policy", html: messaged({ target: "marlow", first, state: "blocked", open: true, body: S.marlowBody("blocked") }) },
        { name: "Open, not sent", html: messaged({ target: "marlow", first, state: "not-sent", open: true, body: S.marlowBody("not-sent") }) },
        { name: "Open, unknown", note: "The sender was stopped before the call returned.", html: messaged({ target: "marlow", first, state: "unknown", open: true, body: S.marlowBody("unknown") }) },
        {
          name: "The receiving side, every state",
          note: "In the recipient's task, at the start of the run the message started. Its state is the recipient's own run.",
          html: ["working", "waiting-you", "replied", "completed", "failed", "stopped"]
            .map((state) => messaged({ target: "otto", verb: "Message from", first, state, body: S.receivingBody(state) }))
            .join(""),
        },
        { name: "The receiving side, open: working", html: messaged({ target: "otto", verb: "Message from", first, state: "working", open: true, body: S.receivingBody("working") }) },
        { name: "The receiving side, open: waiting for you", html: messaged({ target: "otto", verb: "Message from", first, state: "waiting-you", open: true, body: S.receivingBody("waiting-you") }) },
        { name: "The receiving side, open: replied", html: messaged({ target: "otto", verb: "Message from", first, state: "replied", open: true, body: S.receivingBody("replied") }) },
        { name: "The receiving side, open: failed", html: messaged({ target: "otto", verb: "Message from", first, state: "failed", open: true, body: S.receivingBody("failed") }) },
        {
          name: "Messages no card accounts for",
          note: "A message a bot did not ask for, or a late reply that no identifier ties to a card. Each opens to its text and Raw.",
          html:
            CT.eventDetails({ line: `Message from ${CT.avatar("pip")}<b>Pip</b>`, body: S.incomingBody("pip", "Thursday is clear now. I moved the dentist to next week.") }) +
            CT.eventDetails({ line: `Message from ${CT.avatar("marlow")}<b>Marlow</b>`, body: S.incomingBody("marlow", "Late addition for the house log: note that the cache moved to /srv/scratch.") }),
        },
      ],
    },
    {
      id: "t3code",
      title: "The Messaged T3 Code card",
      note: "The same component. It is drawn only from the bot's own tool events; the app never talks to T3 Code. Call made means the call returned, not that the work is finished. A link or a file shows only when a result carries one.",
      specimens: [
        {
          name: "Folded, every state",
          html: ["sending", "call-started", "call-made", "delivery-unknown", "failed", "not-sent"]
            .map((state) => messaged({ target: "t3code", first: S.t3First, state, body: S.t3Body(state) }))
            .join(""),
        },
        { name: "Open, call started", note: "No progress arrives while the call runs.", html: messaged({ target: "t3code", first: S.t3First, state: "call-started", open: true, body: S.t3Body("call-started") }) },
        { name: "Open, call made, with a link in the result", html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made") }) },
        {
          name: "Open, call made, no link and no target fields",
          note: "Nothing is filled in: no Open thread, no chips.",
          html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made", { link: false, fields: false }) }),
        },
        { name: "Open, call made, and the bot was stopped", html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made", { stopped: true }) }) },
        {
          name: "Open, call made, and a later call named this one",
          note: "The bot checked on the work. Its result is added under its own time; the state stays Call made.",
          html: messaged({ target: "t3code", first: S.t3First, state: "call-made", open: true, body: S.t3Body("call-made", { checked: true }) }),
        },
        { name: "Open, delivery unknown", html: messaged({ target: "t3code", first: S.t3First, state: "delivery-unknown", open: true, body: S.t3Body("delivery-unknown") }) },
        { name: "Open, failed", html: messaged({ target: "t3code", first: S.t3First, state: "failed", open: true, body: S.t3Body("failed") }) },
        { name: "Open, not sent", html: messaged({ target: "t3code", first: S.t3First, state: "not-sent", open: true, body: S.t3Body("not-sent") }) },
      ],
    },
    {
      id: "approval",
      title: "Approval cards",
      note: "The card shows the decisions the request offers and no others. Deny is always among them and always visible. Answer any of these: the outcome says what the gateway confirmed.",
      specimens: [
        { name: "Pending", html: approval(S.approval) },
        { name: "Pending, full request and Raw open", html: approval({ ...S.approval, full: { ...S.approval.full, open: true }, rawOpen: true }) },
        { name: "Always allow: the rule, who it covers, where it is saved", note: "Deny stays beside the form's buttons.", html: approval({ ...S.approval, formOpen: true }) },
        {
          name: "Always allow, where the request accepts a lifetime",
          note: "Whole days, from 1 to 3650. Offered only when this kind of request accepts one.",
          html: approval({ ...S.approval, rule: withDays, formOpen: true, lasts: "30" }),
        },
        {
          name: "Always allow, where a stricter setting still asks",
          html: approval({ ...S.approval, rule: stillAsks, formOpen: true }),
        },
        { name: "Always allow: saving", note: "Not marked resolved until the gateway confirms. Deny stays.", still: true, html: approval({ ...S.approval, formOpen: true, save: "saving" }) },
        {
          name: "Always allow: couldn't save",
          html: approval({ ...S.approval, formOpen: true, save: "failed", saveReason: "media-box did not answer." }),
        },
        { name: "A request that offers no reusable rule", note: "The choice is Allow or Deny.", html: approval({ ...S.approval, decisions: ["once", "deny"] }) },
        {
          name: "Asked by a helper",
          html: approval({ ...S.approval, asker: { title: "A helper of Otto wants to run a command", line: "Asked by a helper Otto started for this task." } }),
        },
        {
          name: "Asked by a bot that another bot messaged",
          note: "In Marlow's task. In Otto's task the Messaged card reads Recipient waiting and leads here.",
          html: approval({
            ...S.approval,
            bot: "marlow",
            asker: { title: "Marlow wants to run a command", line: "Marlow is working on a message from Otto." },
            summary: "Append two lines to <b>notes/house-log.md</b> in Otto's workspace.",
            line: "Append two lines to notes/house-log.md",
            rule: { ...S.approval.rule, covers: "Marlow only", where: "The gateway" },
          }),
        },
        { name: "The run has already ended, and the request still stands", html: approval({ ...S.approval, runEnded: true }) },
        {
          name: "With warnings and an expiry",
          html: approval({
            ...S.approval,
            summary: "Delete the old transcode cache on <b>media-box</b>.",
            line: "Delete the old transcode cache on media-box",
            warnings: ["This can't be undone"],
            full: { ...S.approval.full, command: "rm -rf /srv/scratch/transcode-cache" },
            decisions: ["once", "deny"],
            foot: "Expires in 28 minutes; the command is not run if it does.",
          }),
        },
        {
          name: "Asking to message another bot",
          html: approval({
            bot: "otto",
            what: "message Marlow",
            line: "Message Marlow: Write a two-line entry for the house log.",
            summary: "“Write a two-line entry for the house log…”",
            full: { reason: "Otto's outgoing messages are set to ask first.", command: S.marlowSent, fields: [["To", "Marlow"], ["Asked by", "Your message in this task, 5:24 PM"]] },
            rule: { text: "Messages from Otto to Marlow", covers: "Otto only", where: "The gateway" },
            raw: S.approvalRaw(),
          }),
        },
        {
          name: "Resolved, every outcome",
          html: ["once", "always", "denied", "expired", "closed-ended", "closed-failed", "cancelled"]
            .map((state) =>
              approvalResolved({
                state,
                line: S.approval.line,
                when: "5:25 PM",
                full: S.approval.full,
                rule: state === "always" ? S.approval.rule : undefined,
                saved: "5:25 PM",
                raw: S.approvalRaw(state === "once" ? "allow-once" : state === "always" ? "allow-always" : state === "denied" ? "deny" : ""),
              }),
            )
            .join(""),
        },
        {
          name: "Resolved and open: allowed once",
          note: "The command can run. Whether it ran is on its step.",
          html: approvalResolved({ state: "once", line: S.approval.line, when: "5:25 PM", open: true, full: S.approval.full, raw: S.approvalRaw("allow-once") }),
        },
        {
          name: "Resolved and open: always allowed",
          note: "The rule as the gateway saved it.",
          html: approvalResolved({ state: "always", line: S.approval.line, when: "5:25 PM", open: true, rule: S.approval.rule, saved: "5:25 PM", full: S.approval.full, raw: S.approvalRaw("allow-always") }),
        },
        {
          name: "Resolved and open: always allowed for 30 days, replacing the oldest rule",
          html: approvalResolved({
            state: "always",
            line: S.approval.line,
            when: "5:25 PM",
            open: true,
            rule: withDays,
            lasts: "30",
            saved: "5:25 PM",
            replaced: "ls /srv/media (run in /srv)",
            full: S.approval.full,
            raw: S.approvalRaw("allow-always"),
          }),
        },
        { name: "Resolved and open: denied", html: approvalResolved({ state: "denied", line: S.approval.line, when: "5:25 PM", open: true, full: S.approval.full, raw: S.approvalRaw("deny") }) },
        {
          name: "Expired, where the request offered a rule",
          note: "Always allow next time saves the rule for future requests and never runs the expired command.",
          html: approvalResolved({ state: "expired", line: S.approval.line, when: "5:53 PM", open: true, nextTime: S.approval.rule, full: S.approval.full, raw: S.approvalRaw() }),
        },
      ],
    },
    {
      id: "order",
      title: "The permission order",
      note: "The gateway decides; the app shows the case that applied. Strongest first.",
      specimens: [
        {
          name: "1. A denial configured on the gateway",
          note: "A failed step. No card; nothing to approve.",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", failed: 1, open: true, steps: stepBlocked("gateway", { open: true }) }),
        },
        {
          name: "2. A deny rule for this bot",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", failed: 1, open: true, steps: stepBlocked("bot", { open: true }) }),
        },
        {
          name: "3. An ask rule that matches, though a saved allow also matches",
          note: "A card. The full request names the rule that asked.",
          html: approval({
            ...S.approval,
            full: { ...S.approval.full, open: true, review: "", cause: "Asked because of Otto's rule “ask before moving anything under /srv/media”. It outranks the saved allow." },
          }),
        },
        {
          name: "4. A saved allow that is in scope and has not expired",
          note: "An ordinary step that runs. Opened, one line names the rule.",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", open: true, steps: step({ kind: "command", title: "Ran mv", detail: "exit 0", statusText: "1.2s", open: true, body: S.allowedBody() }) }),
        },
        {
          name: "5. The default review: approved",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", open: true, steps: step({ kind: "command", title: "Ran df", detail: "exit 0", statusText: "0.1s", open: true, body: S.reviewedBody() }) }),
        },
        { name: "5. The default review: asks", note: "The ordinary approval card, with the review's line in the full request.", html: approval({ ...S.approval, full: { ...S.approval.full, open: true } }) },
        {
          name: "5. The default review: denied",
          note: "A failed step that stays in view under a folded block.",
          html: activity({ state: "completed", label: "Worked for 22s", count: "4 steps", failed: 1, open: true, steps: stepBlocked("review", { open: true }) }),
        },
      ],
    },
    {
      id: "question",
      title: "Question cards",
      note: "One to three questions, each with two to four options, and always a field for your own words. Answer or dismiss any of these.",
      specimens: [
        { name: "Pending, one answer", note: "Choosing answers at once. A, B, C and D choose from the keyboard.", html: CT.question({ ...question, raw: S.questionRaw() }) },
        { name: "Pending, several answers", html: CT.question({ ...skip, picked: [0, 2], raw: S.questionRaw() }) },
        { name: "Pending, with a typed answer", html: CT.question({ ...question, own: "Two weeks, then ask me", raw: S.questionRaw() }) },
        {
          name: "Pending, three questions",
          note: "Send answers is enabled when every question has an answer.",
          html: CT.question({
            questions: [
              { ...question, picked: [0] },
              skip,
              { title: "Should I tell Marlow when it is done?", options: [["Yes"], ["No"]] },
            ],
            raw: S.questionRaw(),
          }),
        },
        { name: "Answered", html: CT.questionAnswered({ title: question.title, answers: [["A", "A week"]], raw: S.questionRaw({ answers: [["A week"]] }) }) },
        { name: "Answered, several", html: CT.questionAnswered({ title: skip.title, answers: [["A", "Transcode cache"], ["C", "Thumbnails"]], raw: S.questionRaw({ answers: [["Transcode cache", "Thumbnails"]] }) }) },
        { name: "Answered in your own words", html: CT.questionAnswered({ title: question.title, answers: [["", "Two weeks, then ask me"]], raw: S.questionRaw({ answers: [["Two weeks, then ask me"]] }) }) },
        { name: "Dismissed", note: "The bot is told there is no answer, and the run carries on.", html: CT.questionAnswered({ title: question.title, state: "dismissed", raw: S.questionRaw({ dismissed: true }) }) },
        { name: "Expired", html: CT.questionAnswered({ title: question.title, state: "expired", raw: S.questionRaw() }) },
        { name: "Cancelled by Stop", html: CT.questionAnswered({ title: question.title, state: "cancelled", raw: S.questionRaw() }) },
        { name: "Closed because the run ended", html: CT.questionAnswered({ title: question.title, state: "closed-ended", raw: S.questionRaw() }) },
        { name: "Closed because the run failed", html: CT.questionAnswered({ title: question.title, state: "closed-failed", raw: S.questionRaw() }) },
      ],
    },
    {
      id: "composer",
      title: "The composer during a run",
      note: "Send stays. Stop appears beside it for as long as the run can be stopped. What has not been sent waits on a shelf above the pill. These are pictures of each state; every control works in the scripted run.",
      specimens: [
        { name: "No run, empty", still: true, html: CT.composer({ bot: "otto" }) },
        { name: "No run, with text", still: true, html: CT.composer({ bot: "otto", text: "Find out why it was slow." }) },
        { name: "Running, empty", still: true, html: CT.composer({ bot: "otto", run: "running" }) },
        { name: "Running, with text: Enter steers", still: true, html: CT.composer({ bot: "otto", run: "running", text: "Skip the write-up, just fix it." }) },
        { name: "Choosing how to send", still: true, html: `<div style="padding-top:132px">${CT.composer({ bot: "otto", run: "running", text: "Then check the certificate warning too.", menu: true })}</div>` },
        { name: "Running, set to queue", still: true, html: CT.composer({ bot: "otto", run: "running", text: "Then check the certificate warning too.", mode: "queue" }) },
        { name: "A queued message", still: true, html: CT.composer({ bot: "otto", run: "running", shelf: queuedRow() }) },
        {
          name: "Waiting on an approval",
          note: "A message sent now joins the run and leaves the approval pending.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            pending: "approval",
            text: "Use /srv/tmp instead.",
            shelf: CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto needs your approval</b> <span>to run a command</span>", actions: CT.button("Review") }),
          }),
        },
        {
          name: "Waiting on a question, while typing",
          note: "The mode word reads Hold: the message is not the answer.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            pending: "question",
            text: "Also tell me how big it is now.",
            shelf: CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto asked a question.</b> <span>A message sent now is held until you answer.</span>", actions: CT.button("Review") }),
          }),
        },
        {
          name: "A held message",
          note: "Sent into the run once the question is answered or dismissed.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "waiting",
            pending: "question",
            shelf: shelf([
              CT.shelfRow({ lead: glyph("queued"), text: "<b>Held until you answer</b> <span>Also tell me how big it is now.</span>", actions: CT.button("Edit") + CT.button("Cancel", 'data-variant="quiet"') }),
              CT.shelfRow({ tone: "warn", lead: glyph("waiting"), text: "<b>Otto asked you a question</b>", actions: CT.button("Review") }),
            ]),
          }),
        },
        {
          name: "A queued message that couldn't start",
          still: true,
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Couldn't start</b> <span>Otto's daily budget is used up. Then check the certificate warning too.</span>", actions: CT.button("Try again") + CT.button("Delete", 'data-variant="quiet"') }),
          }),
        },
        { name: "Stopping", note: "A message sent now is queued.", still: true, html: CT.composer({ bot: "otto", run: "stopping", text: "" }) },
        {
          name: "Stopping, with a message queued",
          note: "Send now is unavailable until the run has ended.",
          still: true,
          html: CT.composer({ bot: "otto", run: "stopping", shelf: queuedRow("Queued", CT.button("Cancel", 'data-variant="quiet"')) }),
        },
        {
          name: "The stop request failed",
          note: "The run is still running, and Stop is back.",
          still: true,
          html: CT.composer({
            bot: "otto",
            run: "running",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Couldn't stop Otto.</b> <span>The gateway did not answer the stop request.</span>", actions: CT.button("Try again") + `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss this notice">${CT.icon("x")}</button>` }),
          }),
        },
        { name: "Offline", note: "Send works: the host holds the message and sends it once on reconnect.", still: true, html: CT.composer({ bot: "otto", run: "offline", text: "Is the disk still at 61%?" }) },
        { name: "With attachments", still: true, html: CT.composer({ bot: "otto", text: "Here is the usage chart.", files: [{ name: "disk-usage.png", size: 1.4, image: true }, { name: "backup-2026-11-15.log", size: 0.2 }] }) },
        {
          name: "An attachment over its limit",
          note: "The refusal shows before anything is sent. Send is disabled until the file is removed.",
          still: true,
          html: CT.composer({ bot: "otto", text: "Here is the scan.", files: [{ name: "scan.png", size: 8.2, image: true }, { name: "transcode-cache.tar", size: 24 }] }),
        },
        {
          name: "Attachments over the limit for one message",
          still: true,
          html: CT.composer({ bot: "otto", text: "All three.", files: [{ name: "week-1.zip", size: 12 }, { name: "week-2.zip", size: 11.4 }, { name: "chart.png", size: 4, image: true }] }),
        },
        {
          name: "A notice",
          still: true,
          html: CT.composer({
            bot: "otto",
            shelf: CT.shelfRow({ tone: "danger", lead: CT.icon("warning"), text: "<b>Otto failed to respond</b> <span>The model provider is overloaded.</span>", actions: CT.button("Try again") + `<button type="button" class="icon-button" data-variant="quiet" aria-label="Dismiss">${CT.icon("x")}</button>` }),
          }),
        },
      ],
    },
    {
      id: "jump",
      title: "Jump to latest and the status strip",
      note: "New output is followed only when the reader is near the end. Otherwise their place holds and this control appears above the foot of the transcript, pointing at the most urgent thing out of view.",
      specimens: [
        {
          name: "Jump to latest, every state",
          note: "A pending card first, with the arrow pointing at it; then a live run, with the bot's real state; then new output.",
          still: true,
          html: `<div class="spec-row" style="gap:28px 16px">${[
            CT.jump({ state: "needs-you", phrase: "Needs you" }),
            CT.jump({ state: "needs-you", phrase: "Needs you", up: true }),
            CT.jump({ state: "live", bot: "otto", phrase: "Reading the backup log", face: "working" }),
            CT.jump({ state: "live", bot: "otto", phrase: "Thinking", face: "thinking" }),
            CT.jump({ state: "latest" }),
            CT.jump({ state: "latest", phrase: "3 new" }),
          ]
            .map((html) => `<span class="spec-static">${html}</span>`)
            .join("")}</div>`,
        },
        {
          name: "The status strip, every state",
          note: "It sits inside the conversation, under the title pill. Its dot is its own; the count shows only when it is known.",
          still: true,
          html: `<div class="spec-row" style="gap:12px">${["reconnecting", "offline", "syncing", "synced", "failed", "granted"].map((b) => `<span class="spec-static">${CT.banner(b)}</span>`).join("")}<span class="spec-static">${CT.banner("synced", "", "")}</span></div>`,
        },
      ],
    },
    {
      id: "errors",
      title: "Turn errors and notes",
      specimens: [
        {
          name: "A turn failed",
          note: "Copy request ID copies it, Raw shows the error event, and Dismiss folds the card to a line that opens it again.",
          html: CT.turnError({
            title: "Otto couldn't finish this turn",
            reason: "The model provider is overloaded. Nothing ran after step 4, and steps already completed are not undone.",
            requestId: "req_9c1e44a0",
            raw: S.turnErrorRaw,
          }),
        },
        {
          name: "Rate limited",
          html: CT.turnError({ title: "Otto couldn't finish this turn", reason: "This request was rate limited after 5 attempts. Try again in a moment.", requestId: "req_9c1e44a1", raw: S.turnErrorRaw }),
        },
        {
          name: "The run's time limit",
          note: "The gateway says which limit was hit. The step that was running reads Aborted.",
          html: CT.turnError({
            title: "Otto's turn reached its 50 minute limit",
            reason: "The gateway ended the turn so it would not hang. Send a message to pick up where it left off.",
            requestId: "req_9c1e44a2",
            raw: S.turnErrorRaw,
            retry: false,
          }),
        },
        { name: "Stopped", html: stoppedNote },
        {
          name: "Stopped from somewhere else",
          note: "It goes straight to stopped, without Stopping…",
          html: CT.turnNote({ lead: glyph("stopped"), html: "<p><b>Stopped after 40s</b>, from another device or session. Completed steps are not undone.</p><ul><li>Stopped with it: Marlow's run for this message.</li></ul>" }),
        },
        {
          name: "Stopped while a call had started",
          note: "Nothing is claimed that the gateway did not report.",
          html: CT.turnNote({ lead: glyph("stopped"), html: "<p><b>Stopped after 31s.</b> Completed steps are not undone.</p><ul><li>The message to Marlow may or may not have been delivered.</li></ul>" }),
        },
        { name: "Finished before Stop took effect", html: CT.turnNote({ lead: glyph("check"), html: "<p><b>Finished before Stop took effect.</b> The turn completed normally.</p>" }) },
        { name: "Three tool calls timed out", html: CT.turnNote({ lead: CT.icon("warning"), html: "<p><b>Stopped after 3 tool calls in a row timed out.</b> media-box may not be responding.</p>" }) },
      ],
    },
    {
      id: "rows",
      title: "Rows in the rail",
      note: "One table decides every part of a bot's row: the avatar shows the most urgent state among its tasks, line two follows it, and the unread dot is independent. A task row is its title, the time of its last activity and one mark.",
      specimens: [
        {
          name: "Bot rows, in order of urgency",
          rail: true,
          still: true,
          html: `<ul class="bot-list">${[
            { bot: "pip", state: "waiting", preview: "Waiting for you: a question", time: "2m" },
            { bot: "marlow", state: "failed", preview: "Couldn't finish: provider overloaded", time: "9m" },
            { bot: "otto", state: "blocked", preview: "Can't reach media-box", time: "4m" },
            { bot: "pip", state: "done-failed", preview: "Finished with 1 failed step", time: "4:40 PM", unread: true, tone: "failed" },
            { bot: "otto", state: "working", preview: "Reading backup-2026-11-15.log", time: "now" },
            { bot: "marlow", state: "thinking", preview: "Thinking", time: "now" },
            { bot: "juniper", state: "done", preview: "Verdict: usually worth it.", time: "5:02 PM", unread: true },
            { bot: "otto", state: "stopped", preview: "Stopped. Completed steps are not undone.", time: "4:12 PM" },
            { bot: "juniper", state: "idle", preview: "Ask these five, and get the answers in writing.", time: "5:24 PM" },
          ]
            .map((row, i) => CT.botGroup({ ...row, i }))
            .join("")}</ul>`,
        },
        {
          name: "One done with failures, one working",
          note: "Done with failures comes first, with its badge. Opening that task clears it, and the row shows working.",
          rail: true,
          still: true,
          html:
            `<ul class="bot-list">${CT.botGroup({ bot: "otto", state: "done-failed", preview: "Finished with 1 failed step", time: "5:31 PM", unread: true, tone: "failed", open: true, tasks: CT.taskRow({ title: "Rotate the logs on rack-2", status: "running", time: "now" }) + CT.taskRow({ title: "Router firmware", status: "done-failed", time: "5:31 PM" }) })}</ul>` +
            `<p class="spec-then">After opening Router firmware:</p>` +
            `<ul class="bot-list">${CT.botGroup({ bot: "otto", state: "working", preview: "Rotating logs on rack-2", time: "now", open: true, tasks: CT.taskRow({ title: "Rotate the logs on rack-2", status: "running", time: "now" }) + CT.taskRow({ title: "Router firmware", status: "idle", time: "5:31 PM", current: true }) })}</ul>`,
        },
        {
          name: "One waiting, and more recent activity elsewhere",
          note: "The preview stays Waiting for you; the dot says another task has news.",
          rail: true,
          still: true,
          html: `<ul class="bot-list">${CT.botGroup({ bot: "juniper", state: "waiting", preview: "Waiting for you: a question", time: "10m", unread: true, open: true, tasks: CT.taskRow({ title: "Library e-book apps compared", status: "unread", time: "5:40 PM" }) + CT.taskRow({ title: "Heat pump vs. gas furnace", status: "waiting", time: "5:31 PM" }), i: 1 })}</ul>`,
        },
        {
          name: "Task rows, every state",
          rail: true,
          still: true,
          html: `<ul class="bot-list">${CT.botGroup({
            bot: "otto",
            state: "waiting",
            preview: "Waiting for you: approve a command",
            time: "now",
            open: true,
            tasks:
              [
                ["Weekly backup check", "waiting", "now", true],
                ["Disk almost full on the media box", "running", "now"],
                ["Certificate renewal warning", "unread", "5:12 PM"],
                ["Router firmware", "done-failed", "4:40 PM"],
                ["Printer offline again", "failed", "Mon"],
                ["NAS scrub", "blocked", "Mon"],
                ["UPS battery report", "stopped", "Sun"],
                ["Guest Wi-Fi password", "queued", "Sun"],
                ["Thermostat schedule", "idle", "Nov 2"],
              ]
                .map(([title, status, time, current]) => CT.taskRow({ title, status, time, current }))
                .join("") +
              `<li><button type="button" class="task task-more"><span class="task-title">Show all 14</span></button></li>` +
              `<li><button type="button" class="task task-new">${CT.icon("plus")}<span class="task-title">New task</span></button></li>`,
          })}</ul>`,
        },
      ],
    },
    {
      id: "phone",
      title: "The phone",
      note: "Wherever the desktop uses hover or a right-click, the phone uses a tap or touch and hold. Set the width to Phone above to see every component at touch sizes; holding a step or a card there opens these sheets.",
      specimens: [
        {
          name: "Touch and hold on a step",
          still: true,
          html: `<div class="sheet sheet-specimen"><ul class="menu" role="menu"><li><button type="button" class="menu-item" role="menuitem">${CT.icon("copy")}Copy result</button></li><li><button type="button" class="menu-item" role="menuitem">${CT.icon("code")}Copy raw</button></li></ul></div>`,
        },
        {
          name: "The mode word, or touch and hold on Send, during a run",
          still: true,
          html: `<div class="sheet sheet-specimen">${CT.sendMenu(true, "steer", { sheet: true })}</div>`,
        },
        {
          name: "The composer on a phone, during a run with text",
          note: "The mode word keeps its place, so what Enter does is always in view.",
          still: true,
          html: `<div style="max-width:390px" data-input="touch">${CT.composer({ bot: "otto", run: "running", text: "Skip the write-up." })}</div>`,
        },
        {
          name: "The iPhone app: a bot's task list",
          note: "On iPhone, tapping a bot opens its task list, tapping a task opens its chat, and Back returns the same way. The rows are the task rows above, at touch sizes.",
          rail: true,
          still: true,
          html:
            `<div class="phone-list" data-input="touch"><header class="phone-list-head"><span class="icon-button">${CT.icon("back")}</span>${presence("otto", "waiting", { label: false })}<b>Otto</b><span class="icon-button">${CT.icon("plus")}</span></header>` +
            `<ul class="task-list">${[
              ["Weekly backup check", "waiting", "now"],
              ["Disk almost full on the media box", "running", "now"],
              ["Certificate renewal warning", "unread", "5:12 PM"],
              ["Router firmware", "idle", "Mon"],
            ]
              .map(([title, status, time]) => CT.taskRow({ title, status, time }))
              .join("")}</ul></div>`,
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
              `<div class="spec-box${spec.rail ? " spec-rail" : ""}"${spec.still ? " inert" : ""}${spec.lost ? ' data-connection="lost"' : ""}>${spec.html}</div></article>`,
          )
          .join("") +
        `</section>`,
    )
    .join("");

  const nav = document.getElementById("gallery-nav");
  if (nav) nav.innerHTML = sections.map((section) => `<a href="#${section.id}">${section.title}</a>`).join("");
})();
