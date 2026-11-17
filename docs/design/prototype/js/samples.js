// Sample content shared by the gallery and the scripted conversation.
// Everything here is invented: the bots, the machine, the log, the commands.
// Fixtures are honest: a count is the number of lines there really are, and a
// raw view holds the whole payload or says the gateway cut it.

(function () {
  const CT = window.CT;
  const S = (CT.samples = {});
  const json = (value) => JSON.stringify(value, null, 2);

  // The backup log: 96 lines, all of them here.
  const transfers = Array.from({ length: 86 }, (_, i) => {
    const at = 14 * 60 + 10 + i * 49;
    const clock = `0${2 + Math.floor(at / 3600)}:${String(Math.floor((at % 3600) / 60)).padStart(2, "0")}:${String(at % 60).padStart(2, "0")}`;
    return `${clock} transfer: ${(((i + 1) * 187.3) / 86).toFixed(1)} GB of 187.3 GB`;
  });
  S.log = [
    "02:14:03 backup: start profile=weekly target=nas:/backups/media-box",
    "02:14:03 backup: snapshot 2026-11-15 parent=2026-11-08",
    "02:14:09 scan: 48,112 files changed since parent",
    "02:14:09 scan: /srv/media/transcode-cache 41,870 files 182.4 GB (new)",
    ...transfers,
    "03:24:51 transfer: done 187.3 GB in 70m 42s",
    "03:25:02 prune: kept 12 snapshots",
    "03:25:03 backup: finished ok",
    "03:25:03 backup: next run 2026-11-17 02:14",
  ].join("\n");
  S.logLines = S.log.split("\n").length;

  S.ids = (call) => [
    ["Tool call", call],
    ["Item", `tool:${call}`],
    ["Run", "run_7f3a91c2"],
    ["Session", "agent:otto:weekly-backup-check"],
  ];
  const timing = (started, ended, took) => [
    ["Started", started],
    ["Ended", ended || "not reported"],
    ["Took", took || "not reported"],
  ];
  const toolResult = (text, details = {}, isError = false) => json({ content: [{ type: "text", text }], details, isError });

  // Steps: one body for every kind ---------------------------------------------------

  S.readBody = (view = "readable") =>
    CT.stepBody({
      view,
      readable:
        CT.fields([["File", "logs/backup-2026-11-15.log", { mono: true, copy: true, what: "file path" }]]) +
        CT.codeBlock({ label: "Result", text: S.log }),
      raw: {
        tool: "read",
        args: json({ path: "logs/backup-2026-11-15.log" }),
        result: toolResult(S.log, { path: "logs/backup-2026-11-15.log", lines: S.logLines, bytes: S.log.length }),
        timing: timing("5:24:07 PM", "5:24:08 PM", "0.6 s"),
        ids: S.ids("call_01HXK2"),
      },
    });

  const enoent = "ENOENT: no such file or directory, open 'logs/backup-2026-11-08.log'";
  S.failedBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["File", "logs/backup-2026-11-08.log", { mono: true }]]) +
        CT.codeBlock({ label: "Error", text: enoent, tone: "danger" }),
      raw: {
        tool: "read",
        args: json({ path: "logs/backup-2026-11-08.log" }),
        error: enoent,
        timing: timing("5:24:19 PM", "5:24:19 PM", "0.1 s"),
        ids: S.ids("call_01HXK4"),
      },
    });

  S.thoughtText =
    "71 minutes instead of the usual 23. The transfer line is the odd one: 187 GB, where a normal week moves about 5. Something large and new got included. I should compare with last week's log before I blame the network.";

  const thoughtBody = (text, seq, view = "readable") =>
    CT.stepBody({
      view,
      readable: `<p class="step-thought">${text}</p>`,
      raw: {
        events: [["Event as received", json({ stream: "thinking", runId: "run_7f3a91c2", seq, ts: 1794878651204 + seq * 900, data: { text } })]],
        ids: [
          ["Run", "run_7f3a91c2"],
          ["Session", "agent:otto:weekly-backup-check"],
        ],
      },
    });
  S.thoughtBody = (view) => thoughtBody(S.thoughtText, 14, view);
  S.thought2Text = "Last week moved 4.9 GB. This week 187 GB, and 182 of it is the transcode cache. That folder is rebuilt on demand; it never needed backing up.";
  S.thought2Body = () => thoughtBody(S.thought2Text, 31);

  const archive = ["backup-2026-10-04.log.gz", "backup-2026-10-11.log.gz", "backup-2026-10-18.log.gz", "backup-2026-10-25.log.gz", "backup-2026-11-01.log.gz", "backup-2026-11-08.log.gz", "prune-2026-10.log.gz", "prune-2026-11.log.gz", "README"].join("\n");
  S.listBody = () =>
    CT.stepBody({
      readable: CT.fields([["Folder", "logs/archive", { mono: true }]]) + CT.codeBlock({ label: "Entries", text: archive }),
      raw: {
        tool: "ls",
        args: json({ path: "logs/archive" }),
        result: toolResult(archive, { path: "logs/archive", entries: 9 }),
        timing: timing("5:24:21 PM", "5:24:21 PM", "0.2 s"),
        ids: S.ids("call_01HXK5"),
      },
    });

  const lastWeek = [
    "02:14:02 backup: start profile=weekly target=nas:/backups/media-box",
    "02:14:02 backup: snapshot 2026-11-08 parent=2026-11-01",
    "02:14:07 scan: 6,204 files changed since parent",
    "02:36:44 transfer: done 4.9 GB in 22m 37s",
    "02:36:58 prune: kept 12 snapshots",
    "02:36:59 backup: finished ok",
  ].join("\n");
  S.read3Body = () =>
    CT.stepBody({
      readable: CT.fields([["File", "logs/archive/backup-2026-11-08.log.gz", { mono: true }]]) + CT.codeBlock({ label: "Result", text: lastWeek }),
      raw: {
        tool: "read",
        args: json({ path: "logs/archive/backup-2026-11-08.log.gz" }),
        result: toolResult(lastWeek, { path: "logs/archive/backup-2026-11-08.log.gz", lines: 6 }),
        timing: timing("5:24:23 PM", "5:24:24 PM", "1.1 s"),
        ids: S.ids("call_01HXK6"),
      },
    });

  const logEntry = "## Nov 16\n\nLast night's backup ran long: 71 minutes, not the usual 23, because 182 GB of transcode cache was swept in.\nThe cache has been moved out of the backed-up folder.";
  S.writeBody = () =>
    CT.stepBody({
      readable: CT.fields([["File", "notes/house-log.md", { mono: true }], ["Change", "4 lines added, none removed"]]) + CT.codeBlock({ label: "Added", text: logEntry }),
      raw: {
        tool: "edit",
        args: json({ path: "notes/house-log.md", append: logEntry }),
        result: toolResult("Appended 4 lines.", { path: "notes/house-log.md", added: 4, removed: 0 }),
        timing: timing("5:26:31 PM", "5:26:31 PM", "0.3 s"),
        ids: S.ids("call_01HXKD"),
      },
    });

  // A command -----------------------------------------------------------------------

  S.command = "mv /srv/media/transcode-cache /srv/scratch/transcode-cache";
  S.reviewAsk = "Reviewed automatically: asks you. Medium risk. Moves a folder that is outside the bot's workspace.";

  // stage: review, waiting, running, done, denied.
  S.commandBody = (stage = "done") => {
    const review = stage === "review" ? "Review: in progress" : S.reviewAsk;
    const args = json({ command: S.command, cwd: "/srv/media", host: "media-box" });
    const done = stage === "done";
    return CT.stepBody({
      readable:
        CT.fields([
          ["Command", S.command, { mono: true, copy: true }],
          ["Runs on", "media-box"],
          ["Folder", "/srv/media", { mono: true }],
        ]) +
        CT.note(review) +
        (done
          ? CT.note("The command printed nothing.") + CT.fields([["Exit code", "0"]])
          : stage === "running"
            ? CT.note("No output yet.")
            : stage === "denied"
              ? CT.note("The command was not run.")
              : ""),
      raw: {
        tool: "exec",
        args,
        result: done ? toolResult("", { exitCode: 0, cwd: "/srv/media" }) : "",
        running: stage === "running",
        events:
          stage === "review"
            ? [["Review as received", json({ type: "exec.review", id: "rev_02c1", state: "running" })]]
            : [
                ["Review as received", json({ type: "exec.review", id: "rev_02c1", verdict: "ask", risk: "medium", reason: "Moves a folder that is outside the bot's workspace." })],
                ...(stage === "waiting" ? [] : [["Approval as received", S.approvalEvents(stage === "denied" ? "deny" : "allow-once")[1][1]]]),
              ],
        timing: done ? timing("5:25:42 PM", "5:25:43 PM", "1.2 s") : stage === "running" ? timing("5:25:42 PM") : undefined,
        ids: S.ids("call_01HXKB"),
      },
    });
  };

  // A command whose output is streaming.
  const usage = "182G\t/srv/media/transcode-cache\n640G\t/srv/media/films\n211G\t/srv/media/series\n";
  S.liveBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["Command", "du -sh /srv/media/*", { mono: true, copy: true }], ["Runs on", "media-box"]]) +
        CT.codeBlock({ label: "Output so far", copy: "output", text: usage, live: true }),
      raw: { tool: "exec", args: json({ command: "du -sh /srv/media/*", host: "media-box" }), running: true, timing: timing("5:25:02 PM"), ids: S.ids("call_01HXK9") },
    });

  // A non-zero exit code is the command's answer, not a failed step.
  S.exitBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["Command", "grep -c transcode /etc/backup/exclude", { mono: true, copy: true }], ["Runs on", "media-box"]]) +
        CT.codeBlock({ label: "Output", text: "0" }) +
        CT.fields([["Exit code", "1"]]),
      raw: {
        tool: "exec",
        args: json({ command: "grep -c transcode /etc/backup/exclude", host: "media-box" }),
        result: toolResult("0", { exitCode: 1 }),
        timing: timing("5:24:40 PM", "5:24:40 PM", "0.1 s"),
        ids: S.ids("call_01HXK7"),
      },
    });

  // limit: "command", the command's own limit; "run", the run's.
  S.timeoutBody = (limit = "command") =>
    CT.stepBody({
      readable:
        CT.fields([["Command", "rsync -a /srv/media/ nas:/backups/media-box/", { mono: true, copy: true }], ["Runs on", "media-box"]]) +
        CT.note(
          limit === "command"
            ? "<b>Timed out.</b> The command reached its own limit of 120 seconds and was ended. The run went on."
            : "<b>Aborted.</b> The run reached its 50 minute limit while this command was running.",
        ),
      raw: {
        tool: "exec",
        args: json({ command: "rsync -a /srv/media/ nas:/backups/media-box/", host: "media-box", timeoutSeconds: 120 }),
        error: json({ timeout: { limit: limit === "command" ? "command" : "run", seconds: limit === "command" ? 120 : 3000 }, aborted: limit === "run" }),
        timing: timing("5:24:50 PM", limit === "command" ? "5:26:50 PM" : "6:14:07 PM", limit === "command" ? "120 s" : "49m 17s"),
        ids: S.ids("call_01HXK8"),
      },
    });

  // Output the gateway cut: exactly the first 8,000 characters.
  const journal = Array.from({ length: 140 }, (_, i) => `Nov 16 02:${String(14 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 9) % 60).padStart(2, "0")} media-box transcoded[812]: cache write segment ${String(i + 1).padStart(4, "0")} ok`).join("\n");
  S.cut = journal.slice(0, 8000);
  S.truncatedBody = (view = "readable") =>
    CT.stepBody({
      view,
      readable:
        CT.fields([["Command", "journalctl -u transcoded --since yesterday", { mono: true, copy: true }], ["Runs on", "media-box"]]) +
        CT.codeBlock({ label: "Output", text: S.cut, truncated: true }) +
        CT.fields([["Exit code", "0"]]),
      raw: {
        tool: "exec",
        args: json({ command: "journalctl -u transcoded --since yesterday", host: "media-box" }),
        result: toolResult(S.cut, { exitCode: 0, truncated: true, limit: 8000 }),
        truncated: true,
        timing: timing("5:24:44 PM", "5:24:45 PM", "0.9 s"),
        ids: S.ids("call_01HXKA"),
      },
    });

  // source: gateway, bot, review.
  S.blockedBody = (source = "bot") => {
    const decided = {
      gateway: ["A rule on the gateway", "commands matching 'rm -rf' are never run on media-box", "The gateway's own rule comes before anything set for a bot."],
      bot: ["Otto's rule", "never run rm", "A deny comes before any saved allow."],
      review: ["The automatic review", "High risk. Deletes a folder that cannot be restored.", "Reviewed automatically: denied."],
    }[source];
    return CT.stepBody({
      readable:
        CT.fields([
          ["Command", "rm -rf /srv/media/transcode-cache", { mono: true }],
          ["Decided by", decided[0]],
          [source === "review" ? "Reason" : "Rule", decided[1]],
        ]) + CT.note(`${decided[2]} The command was not run.`),
      raw: {
        tool: "exec",
        args: json({ command: "rm -rf /srv/media/transcode-cache", host: "media-box" }),
        error: json({ denied: true, source: source === "review" ? "review" : source === "gateway" ? "gateway-policy" : "agent-policy", reason: decided[1] }),
        ids: S.ids("call_01HXKE"),
      },
    });
  };

  // An ordinary step that a saved rule allowed.
  S.allowedBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["Command", S.command, { mono: true, copy: true }], ["Runs on", "media-box"], ["Folder", "/srv/media", { mono: true }]]) +
        CT.note("Allowed by a saved rule: this command run in /srv/media, for Otto only, saved on media-box.") +
        CT.note("The command printed nothing.") +
        CT.fields([["Exit code", "0"]]),
      raw: { tool: "exec", args: json({ command: S.command, cwd: "/srv/media", host: "media-box" }), result: toolResult("", { exitCode: 0, allowedBy: "rule_19" }), timing: timing("5:25:42 PM", "5:25:43 PM", "1.2 s"), ids: S.ids("call_01HXKF") },
    });

  // A command the review approved: one quiet line.
  S.reviewedBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["Command", "df -h /srv/media", { mono: true, copy: true }], ["Runs on", "media-box"]]) +
        CT.note("Reviewed automatically: approved. Low risk. Reads disk usage and changes nothing.") +
        CT.codeBlock({ label: "Output", text: "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sdb1       1.8T  1.1T  640G  64% /srv/media" }) +
        CT.fields([["Exit code", "0"]]),
      raw: {
        tool: "exec",
        args: json({ command: "df -h /srv/media", host: "media-box" }),
        result: toolResult("Filesystem      Size  Used Avail Use% Mounted on\n/dev/sdb1       1.8T  1.1T  640G  64% /srv/media", { exitCode: 0 }),
        events: [["Review as received", json({ type: "exec.review", id: "rev_02b7", verdict: "allow", risk: "low", reason: "Reads disk usage and changes nothing." })]],
        timing: timing("5:24:30 PM", "5:24:30 PM", "0.1 s"),
        ids: S.ids("call_01HXKC"),
      },
    });

  // Messages ------------------------------------------------------------------------

  S.marlowSent =
    "Write a two-line entry for the house log. Last night's backup took 71 minutes instead of 23, because the transcode cache (182 GB) was included. I am moving it out of the backed-up folder.";
  S.marlowFirst = "Write a two-line entry for the house log.";
  S.marlowReply =
    "<p><strong>Nov 16.</strong> Last night's backup ran long: 71 minutes, not the usual 23, because 182 GB of transcode cache was swept in.</p><p>The cache has been moved out of the backed-up folder, so tonight's run should be back to normal.</p>";

  const sendArgs = json({ sessionKey: "agent:marlow:main", message: S.marlowSent });
  const sendResults = {
    sent: { status: "accepted", runId: "run_41b0c7d9", sessionKey: "agent:marlow:main" },
    replied: { status: "ok", runId: "run_41b0c7d9", sessionKey: "agent:marlow:main", reply: "Nov 16. Last night's backup ran long: 71 minutes, not the usual 23, because 182 GB of transcode cache was swept in. The cache has been moved out of the backed-up folder, so tonight's run should be back to normal." },
    "no-reply": { status: "timeout", runId: "run_41b0c7d9", sessionKey: "agent:marlow:main" },
    "recipient-stopped": { status: "aborted", runId: "run_41b0c7d9", sessionKey: "agent:marlow:main" },
  };
  S.marlowRaw = (state) => {
    const settled = { working: "sent", "recipient-waiting": "sent" }[state] || state;
    const result = sendResults[settled];
    return {
      tool: "sessions_send",
      args: sendArgs,
      result: result ? toolResult(json(result)) : "",
      error:
        state === "failed"
          ? "sessions_send: the recipient's session could not be started (model provider overloaded)"
          : state === "blocked"
            ? json({ denied: true, source: "agent-policy", reason: "Otto may not message other bots after 11 PM" })
            : "",
      running: ["sending", "call-started", "approval"].includes(state),
      timing: result || state === "failed" ? timing("5:24:58 PM", "5:25:39 PM", "41 s") : timing("5:24:58 PM"),
      ids: [...S.ids("call_01HXK8M"), ...(result ? [["Recipient run", "run_41b0c7d9"], ["Recipient session", "agent:marlow:main"]] : [])],
    };
  };

  // Every message between the two bots in this task, for "Show full exchange".
  const fullExchange = (reply) => [
    { who: "otto", verb: "sent", time: "Mon 9:02 AM", html: `<div class="exchange-text"><p>What tone does the house log use? One line is enough.</p></div>` },
    { who: "marlow", verb: "replied", time: "Mon 9:02 AM", html: `<div class="exchange-text"><p>Plain past tense, dated, no names.</p></div>` },
    { who: "otto", verb: "sent", time: "5:24 PM", html: `<div class="exchange-text"><p>${S.marlowSent}</p></div>` },
    ...(reply ? [{ who: "marlow", verb: "replied", time: "5:25 PM", html: `<div class="exchange-text">${S.marlowReply}</div>` }] : []),
  ];

  // The expanded body of a Messaged card to another bot, for any state.
  S.marlowBody = (state, { phrase = "Reading the house log", denied = true } = {}) => {
    const sent = { who: "otto", verb: "sent", time: "5:24 PM", html: `<div class="exchange-text"><p>${S.marlowSent}</p></div>` };
    const back = CT.cameBack(state, {
      sender: "otto",
      recipient: "marlow",
      phrase,
      reply: S.marlowReply,
      time: "5:25 PM",
      error: "sessions_send: the recipient's session could not be started (model provider overloaded)",
      rule: "Otto may not message other bots after 11 PM",
      denied,
    });
    const known = ["sent", "working", "recipient-waiting", "no-reply", "replied", "recipient-stopped"].includes(state); // the result named Marlow's task
    return (
      CT.exchange([sent, back], 'data-exchange="one"') +
      CT.exchange(fullExchange(state === "replied"), 'data-exchange="all" hidden') +
      CT.cardFoot(
        (state === "approval" ? CT.linkButton("Show the approval", { action: "show-approval", name: "Show the approval for this message" }) : "") +
          (known ? CT.linkButton("Open in Marlow", { icon: "external", action: "open-recipient", name: "Open this message in Marlow's task" }) : "") +
          (known ? CT.linkButton("Show full exchange", { action: "full-exchange", attrs: 'aria-expanded="false"', name: "Show every message between Otto and Marlow in this task" }) : ""),
        S.marlowRaw(state),
      )
    );
  };

  // The receiving side: the card at the start of the recipient's run.
  S.receivingBody = (state) => {
    const sent = { who: "otto", verb: "sent", time: "5:24 PM", html: `<div class="exchange-text"><p>${S.marlowSent}</p></div>` };
    const line = (text, extra = "") => ({ who: "marlow", verb: "", html: CT.note(text) + extra });
    const back = {
      working: line("Marlow is working on this. Its status is at the foot of this conversation."),
      "waiting-you": line("Marlow asked you a question below.", `<p class="exchange-note">${CT.linkButton("Show the question", { action: "elsewhere", attrs: 'data-where="Scrolls to Marlow\'s question card and focuses it."' })}</p>`),
      replied: { who: "marlow", verb: "replied", time: "5:25 PM", html: `<div class="exchange-text">${S.marlowReply}</div>` },
      completed: line("This run finished without a reply to Otto."),
      failed: line("This run failed: the model provider was overloaded. Nothing was written."),
      stopped: line("This run was stopped before it replied."),
    }[state];
    return (
      CT.exchange([sent, back]) +
      CT.cardFoot(CT.linkButton("Open in Otto", { icon: "external", action: "open-sender", name: "Open this message in Otto's task" }), {
        events: [["Event as received", json({ type: "session.message", from: "agent:otto:weekly-backup-check", runId: "run_41b0c7d9", message: S.marlowSent })]],
        ids: [["Run", "run_41b0c7d9"], ["Session", "agent:marlow:main"], ["Sender run", "run_7f3a91c2"], ["Sender session", "agent:otto:weekly-backup-check"]],
      })
    );
  };

  // A message no card accounts for: it opens to its text and Raw.
  S.incomingBody = (who, text) =>
    CT.exchange([{ who, verb: "sent", time: "5:41 PM", html: `<div class="exchange-text"><p>${text}</p></div>` }]) +
    CT.cardFoot("", {
      events: [["Event as received", json({ type: "session.message", from: `agent:${who}:main`, message: text })]],
      ids: [["Session", "agent:otto:weekly-backup-check"], ["Sender session", `agent:${who}:main`]],
    });

  // T3 Code -------------------------------------------------------------------------

  S.t3Sent =
    "In backup-scripts, add /srv/media/transcode-cache to the exclude list in weekly.sh. Also add a check that fails the run when an excluded path shows up in the transfer list.";
  S.t3First = "In backup-scripts, add the cache to the exclude list in weekly.sh.";
  S.t3Link = "https://t3code.example/threads/18";
  const t3Returned = "Accepted. Thread 18 in backup-scripts.";

  // link: the result carries a link. fields: the arguments carry target fields.
  // stopped: the bot was stopped after the call was made. checked: a later call named this one.
  S.t3Body = (state, { link = true, fields = true, stopped = false, checked = false } = {}) => {
    const made = state === "call-made";
    const args = { text: S.t3Sent, ...(fields ? { project: "backup-scripts", branch: "main" } : {}) };
    const result = { status: "accepted", thread: 18, ...(link ? { url: S.t3Link } : {}) };
    return (
      CT.exchange([
        {
          who: "otto",
          verb: "sent",
          time: "5:24 PM",
          html:
            `<div class="exchange-text"><p>${S.t3Sent}</p></div>` +
            (fields ? `<div class="chips"><span class="chip"><span>Project</span>backup-scripts</span><span class="chip"><span>Branch</span>main</span></div>` : ""),
        },
        CT.cameBack(state, { sender: "otto", recipient: "t3code", reply: `<p>${t3Returned}</p>`, time: "5:24 PM", error: "connect ECONNREFUSED: the coding agent's server did not answer" }),
        ...(checked
          ? [
              {
                who: "t3code",
                verb: "· Otto checked",
                time: "5:41 PM",
                html:
                  `<div class="exchange-text"><p>Added the exclude and a guard to weekly.sh, with a test for the guard. Opened a pull request with both changes.</p></div>` +
                  `<div class="chips"><span class="chip">${CT.icon("file")}weekly.sh</span><span class="chip">${CT.icon("file")}test/exclude.bats</span></div>`,
              },
            ]
          : []),
      ]) +
      (stopped && made ? CT.note("<b>The call was made. Work handed to T3 Code may continue there.</b>") : "") +
      CT.cardFoot(
        made && link
          ? `<a class="link-button" href="${S.t3Link}" data-action="open-thread" aria-label="Open the T3 Code thread in your browser">Open thread${CT.icon("external")}</a>`
          : "",
        {
          tool: "t3code__send_message",
          args: json(args),
          result: made ? toolResult(json(result)) : "",
          error: state === "failed" ? "connect ECONNREFUSED: the coding agent's server did not answer" : "",
          running: state === "sending" || state === "call-started",
          timing: made || state === "failed" ? timing("5:25:41 PM", "5:25:42 PM", "0.8 s") : timing("5:25:41 PM"),
          ids: S.ids("call_01HXK9T"),
        },
      )
    );
  };

  S.messageStepBody = (state) =>
    CT.stepBody({
      readable:
        CT.fields([["To", "Marlow"], ["State", CT.stateWords[state]]]) +
        CT.codeBlock({ label: "Sent", copy: "sent text", text: S.marlowSent }) +
        `<p class="exchange-note">${CT.linkButton("Show the card", { action: "show-card", attrs: 'data-card="m-marlow"' })}</p>`,
      raw: S.marlowRaw(state),
    });

  S.agentStepBody = (state) =>
    CT.stepBody({
      readable:
        CT.fields([["To", "T3 Code"], ["Project", "backup-scripts"], ["Branch", "main"], ["State", CT.stateWords[state]]]) +
        CT.codeBlock({ label: "Sent", copy: "sent text", text: S.t3Sent }) +
        `<p class="exchange-note">${CT.linkButton("Show the card", { action: "show-card", attrs: 'data-card="m-t3"' })}</p>`,
      raw: {
        tool: "t3code__send_message",
        args: json({ text: S.t3Sent, project: "backup-scripts", branch: "main" }),
        result: state === "call-made" ? toolResult(json({ status: "accepted", thread: 18, url: S.t3Link })) : "",
        running: state !== "call-made",
        timing: state === "call-made" ? timing("5:25:41 PM", "5:25:42 PM", "0.8 s") : timing("5:25:41 PM"),
        ids: S.ids("call_01HXK9T"),
      },
    });

  // Approvals -----------------------------------------------------------------------

  // The request, and the resolving event once there is one.
  S.approvalEvents = (decision = "") => [
    ["Request as received", json({ type: "exec.approval.requested", id: "apr_5d2a", runId: "run_7f3a91c2", toolCallId: "call_01HXKB", command: S.command, cwd: "/srv/media", host: "media-box", allowAlways: true })],
    ...(decision ? [["Resolution as received", json({ type: "exec.approval.resolved", id: "apr_5d2a", decision, ...(decision === "allow-always" ? { rule: { id: "rule_19", agent: "otto", command: S.command, cwd: "/srv/media" } } : {}) })]] : []),
  ];
  S.approvalRaw = (decision = "") => ({
    events: S.approvalEvents(decision),
    ids: [["Approval", "apr_5d2a"], ["Tool call", "call_01HXKB"], ["Run", "run_7f3a91c2"], ["Session", "agent:otto:weekly-backup-check"]],
  });

  S.approval = {
    bot: "otto",
    what: "run a command",
    line: "Move the transcode cache out of /srv/media on media-box",
    summary: "Move the transcode cache from /srv/media to /srv/scratch on <b>media-box</b>.",
    full: {
      reason: "The command moves a folder that is outside Otto's own workspace.",
      command: S.command,
      fields: [
        ["Runs on", "media-box"],
        ["Folder", "/srv/media", { mono: true }],
        ["Asked by", "Your message in this task, 5:24 PM"],
      ],
      review: S.reviewAsk,
    },
    // What this request offers, as the request carries it.
    decisions: ["once", "always", "deny"],
    rule: { text: `${S.command}\nrun in /srv/media`, covers: "Otto only", where: "media-box, the machine this runs on" },
    raw: S.approvalRaw(),
  };

  // Questions -----------------------------------------------------------------------

  S.question = {
    title: "How long should I keep the cache in /srv/scratch before deleting it?",
    options: [["A week", "Delete it next Monday"], ["A month"], ["Until I say so", "Keep it and remind me"], ["Delete it now"]],
  };
  S.questionRaw = (answer) => ({
    events: [
      ["Question as received", json({ type: "question.requested", id: "qst_81f0", runId: "run_7f3a91c2", questions: [{ title: S.question.title, options: S.question.options.map(([label]) => label), multiSelect: false }] })],
      ...(answer ? [["Answer as sent", json({ type: "question.resolved", id: "qst_81f0", ...answer })]] : []),
    ],
    ids: [["Question", "qst_81f0"], ["Run", "run_7f3a91c2"], ["Session", "agent:otto:weekly-backup-check"]],
  });

  S.turnErrorRaw = {
    events: [["Event as received", json({ type: "chat", state: "error", runId: "run_7f3a91c2", error: { code: "provider_overloaded", message: "The model provider is overloaded.", requestId: "req_9c1e44a0" } })]],
    ids: [["Request", "req_9c1e44a0"], ["Run", "run_7f3a91c2"], ["Session", "agent:otto:weekly-backup-check"]],
  };
})();
