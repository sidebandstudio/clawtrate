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
        events: [["Event (a sample in the app's own shape)", json({ stream: "thinking", runId: "run_7f3a91c2", seq, ts: 1794878651204 + seq * 900, data: { text } })]],
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
  S.reviewAsk = "Reviewed automatically: not approved. Medium risk. Moves a folder that is outside the bot's workspace.";

  // The review's record, in the tool event the gateway emits for it. The gateway adds
  // `seq` and `ts` to every agent event before it publishes it.
  const reviewEvent = (status, decided) => {
    const toolCallId = decided?.toolCallId || "call_01HXKB";
    return json({
      runId: "run_7f3a91c2",
      seq: status === "in_progress" ? 41 : 42,
      stream: "tool",
      ts: status === "in_progress" ? 1794787263120 : 1794787264870,
      sessionKey: "agent:otto:weekly-backup-check",
      data: {
        phase: "review",
        name: "exec",
        toolCallId,
        hideFromChannelProgress: true,
        approvalReviewOutcome: status === "in_progress" ? "reviewing" : status,
        review: {
          id: `guardian:${toolCallId}`,
          label: "Guardian",
          status,
          ...(decided ? { riskLevel: decided.riskLevel || "medium", rationale: decided.rationale || "Moves a folder that is outside the bot's workspace." } : {}),
        },
      },
    });
  };

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
            ? [["Tool event, phase review, as the gateway sends it", reviewEvent("in_progress")]]
            : [
                ["Tool event, phase review, as the gateway sends it", reviewEvent("denied", {})],
                ...(stage === "waiting" ? [] : [S.approvalEvents(stage === "denied" ? "deny" : "allow-once")[1]]),
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

  // Output the gateway cut. Where it cuts depends on the path and the settings.
  const journal = Array.from({ length: 140 }, (_, i) => `Nov 16 02:${String(14 + Math.floor(i / 6)).padStart(2, "0")}:${String((i * 9) % 60).padStart(2, "0")} media-box transcoded[812]: cache write segment ${String(i + 1).padStart(4, "0")} ok`).join("\n");
  S.cut = journal.slice(0, 7930) + "\n…(truncated)…"; // the gateway's own marker, shown as received
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
        result: toolResult(S.cut, { exitCode: 0 }),
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

  // A command the gateway's policy allowed with no request. No review line, no rule line.
  S.allowedBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["Command", S.command, { mono: true, copy: true }], ["Runs on", "media-box"], ["Folder", "/srv/media", { mono: true }]]) +
        CT.note("The command printed nothing.") +
        CT.fields([["Exit code", "0"]]),
      raw: { tool: "exec", args: json({ command: S.command, cwd: "/srv/media", host: "media-box" }), result: toolResult("", { exitCode: 0 }), timing: timing("5:25:42 PM", "5:25:43 PM", "1.2 s"), ids: S.ids("call_01HXKF") },
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
        events: [["Tool event, phase review, as the gateway sends it", reviewEvent("approved", { toolCallId: "call_01HXKC", riskLevel: "low", rationale: "Reads disk usage and changes nothing." })]],
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
  const target = { runId: "run_41b0c7d9", sessionKey: "agent:marlow:main" };
  const sendResults = {
    sent: { ...target, status: "accepted", targetDisposition: "queued", delivery: { status: "skipped" } },
    replied: { ...target, status: "ok", delivery: { status: "skipped" }, reply: "Nov 16. Last night's backup ran long: 71 minutes, not the usual 23, because 182 GB of transcode cache was swept in. The cache has been moved out of the backed-up folder, so tonight's run should be back to normal." },
    "no-reply": { ...target, status: "no_reply", message: "The target run finished without a reply." },
    timeout: { ...target, status: "timeout", error: "timed out waiting for a reply", sentBeforeError: true },
  };
  S.marlowRaw = (state) => {
    const settled = { working: "sent", "recipient-waiting": "sent", "recipient-stopped": "sent", "recipient-failed": "sent" }[state] || state;
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
      running: ["call-started", "approval"].includes(state),
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
  S.marlowBody = (state, { phrase = "Reading the house log", denied = true, timeout = false } = {}) => {
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
      timeout,
    });
    const known = ["sent", "working", "recipient-waiting", "no-reply", "replied", "recipient-stopped", "recipient-failed"].includes(state); // the result named Marlow's task
    return (
      CT.exchange([sent, back], 'data-exchange="one"') +
      CT.exchange(fullExchange(state === "replied"), 'data-exchange="all" hidden') +
      CT.cardFoot(
        (state === "approval" ? CT.linkButton("Show the approval", { action: "show-approval", name: "Show the approval for this message" }) : "") +
          (known ? CT.linkButton("Open in Marlow", { icon: "external", action: "open-recipient", name: "Open this message in Marlow's task" }) : "") +
          (known ? CT.linkButton("Show full exchange", { action: "full-exchange", attrs: 'aria-expanded="false"', name: "Show every message between Otto and Marlow in this task" }) : ""),
        S.marlowRaw(timeout ? "timeout" : state),
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
        events: [["Event (a sample in the app's own shape)", json({ type: "session.message", from: "agent:otto:weekly-backup-check", runId: "run_41b0c7d9", message: S.marlowSent })]],
        ids: [["Run", "run_41b0c7d9"], ["Session", "agent:marlow:main"], ["Sender run", "run_7f3a91c2"], ["Sender session", "agent:otto:weekly-backup-check"]],
      })
    );
  };

  // A message no card accounts for: it opens to its text and Raw.
  S.incomingBody = (who, text) =>
    CT.exchange([{ who, verb: "sent", time: "5:41 PM", html: `<div class="exchange-text"><p>${text}</p></div>` }]) +
    CT.cardFoot("", {
      events: [["Event (a sample in the app's own shape)", json({ type: "session.message", from: `agent:${who}:main`, message: text })]],
      ids: [["Session", "agent:otto:weekly-backup-check"], ["Sender session", `agent:${who}:main`]],
    });

  // T3 Code -------------------------------------------------------------------------

  S.t3Sent =
    "In backup-scripts, add /srv/media/transcode-cache to the exclude list in weekly.sh. Also add a check that fails the run when an excluded path shows up in the transfer list.";
  S.t3First = "In backup-scripts, add the cache to the exclude list in weekly.sh.";
  S.t3Link = "https://t3.example/threads/env-home/mcp:6f0c2b1e-9d4a-4c31-b8f7-2a5e0d91c4aa";
  const t3Returned = "Thread started in backup-scripts; its first run: Running.";

  // link: the result carries a link. fields: the arguments carry target fields.
  // stopped: the bot was stopped after the call was made. checked: a later call named this one.
  S.t3Body = (state, { link = true, fields = true, stopped = false, checked = false } = {}) => {
    const made = state === "call-made";
    const args = { message: S.t3Sent, title: "Exclude the transcode cache", ...(fields ? { projectId: "backup-scripts", workspaceStrategy: { type: "worktree", baseRef: "main", branch: "main" } } : { scratch: true }) };
    const result = { threadId: "mcp:6f0c2b1e-9d4a-4c31-b8f7-2a5e0d91c4aa", ...(link ? { link: S.t3Link } : {}), projectId: "backup-scripts", runId: "run_t3_1", status: "running" };
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
          ? // In the app this is a link to the address the result carries. Here it only says so.
            `<a class="link-button" href="#" data-href="${S.t3Link}" data-action="open-thread" aria-label="Open the T3 Code thread in your browser">Open thread${CT.icon("external")}</a>`
          : "",
        {
          tool: "t3code__t3_thread_launch",
          args: json(args),
          result: made ? json({ content: [{ type: "text", text: `structuredContent:\n${JSON.stringify(result)}` }], details: { mcpServer: "t3code", mcpTool: "t3_thread_launch", structuredContent: result }, isError: false }) : "",
          error: state === "failed" ? "connect ECONNREFUSED: the coding agent's server did not answer" : "",
          running: state === "call-started" || state === "approval",
          timing: made || state === "failed" ? timing("5:25:41 PM", "5:25:42 PM", "0.8 s") : timing("5:25:41 PM"),
          ids: S.ids("call_01HXK9T"),
        },
      )
    );
  };

  S.t3Followup = "Also add a test for the guard, and open a pull request with both changes.";

  S.messageStepBody = (state) =>
    CT.stepBody({
      readable:
        CT.fields([["To", "Marlow"], ["State", CT.stateWords[state]]]) +
        CT.codeBlock({ label: "Sent", copy: "sent text", text: S.marlowSent }) +
        `<p class="exchange-note">${CT.linkButton("Show the card", { action: "show-card", attrs: 'data-card="m-marlow"' })}</p>`,
      raw: S.marlowRaw(state),
    });

  // Approvals -----------------------------------------------------------------------

  // The request's fields as the gateway builds them, and the decision as the app
  // sends it. The gateway's confirmation carries no saved rule.
  S.approvalRequest = {
    command: S.command,
    cwd: "/srv/media",
    nodeId: "media-box",
    host: "node",
    security: "allowlist",
    ask: "on-miss",
    warningText: null,
    allowedDecisions: ["allow-once", "allow-always", "deny"],
    agentId: "otto",
    sessionKey: "agent:otto:weekly-backup-check",
    runId: "run_7f3a91c2",
    toolCallId: "call_01HXKB",
  };
  S.approvalEvents = (decision = "") => [
    ["Request fields, as the gateway builds them", json(S.approvalRequest)],
    ...(decision ? [["Decision (exec.approval.resolve), as the app sends it", json({ id: "apr_5d2a", decision })]] : []),
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
      cause: {
        text: "The automatic review did not approve this, so the gateway asks.",
        label: "Manage settings",
        where: "Opens Settings, Permissions, at the automatic review. That needs admin access, asked for the first time it is opened.",
      },
    },
    // What this request offers, as the request carries it.
    decisions: ["once", "always", "deny"],
    request: { command: S.command, cwd: "/srv/media", host: "media-box", agent: "Otto" },
    kind: "command",
    raw: S.approvalRaw(),
  };

  // Questions -----------------------------------------------------------------------

  S.question = {
    title: "How long should I keep the cache in /srv/scratch before deleting it?",
    options: [["A week", "Delete it next Monday"], ["A month"], ["Until I say so", "Keep it and remind me"], ["Delete it now"]],
  };
  S.questionRaw = (answer) => ({
    events: [
      [
        "question.requested, as the gateway sends it",
        json({
          id: "qst_81f0",
          questions: [{ questionId: "keep_cache", header: "Keep cache", question: S.question.title, options: S.question.options.map(([label]) => ({ label })), isOther: true }],
          agentId: "otto",
          sessionKey: "agent:otto:weekly-backup-check",
          runId: "run_7f3a91c2",
          createdAtMs: 1794878774000,
          expiresAtMs: 1794879674000,
          status: "pending",
        }),
      ],
      ...(answer
        ? [
            [
              "question.resolved, as the gateway sends it",
              json(answer.dismissed ? { id: "qst_81f0", status: "cancelled" } : { id: "qst_81f0", status: "answered", answers: { answers: { keep_cache: answer.answers.flat() } } }),
            ],
          ]
        : []),
    ],
    ids: [["Question", "qst_81f0"], ["Run", "run_7f3a91c2"], ["Session", "agent:otto:weekly-backup-check"]],
  });

  // A record the ordinary card does not take: a form with a link.
  S.questionOtherRaw = {
    events: [
      [
        "question.requested, as the gateway sends it",
        json({
          id: "qst_90a2",
          questions: [{ questionId: "sign_in", header: "Sign in", question: "Sign in to the backup provider, then confirm.", url: "https://backup.example/sign-in", options: [], presentation: "form" }],
          agentId: "otto",
          sessionKey: "agent:otto:weekly-backup-check",
          runId: "run_7f3a91c2",
          createdAtMs: 1794878774000,
          expiresAtMs: 1794879674000,
          status: "pending",
        }),
      ],
    ],
    ids: [["Question", "qst_90a2"], ["Run", "run_7f3a91c2"], ["Session", "agent:otto:weekly-backup-check"]],
  };

  // Action cards: one fixture call per kind ----------------------------------------------
  //
  // The shapes of `args` and `details` follow what a development gateway recorded
  // for each family (docs/decisions.md, "What each kind of tool call looks like").
  // Families that cannot run there (web pages, posts on X, memory search, the
  // browser, the computer, media, channels, helpers) use samples in the app's own
  // shape, and their open points say so. Every name and text here is invented.

  const at = (s) => `5:2${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} PM`;
  let tick = 0;
  const call = (id, name, args, more = {}) => {
    tick += 3;
    return { id, name, args, started: at(tick), ended: at(tick + 1), took: "0.4s", ...more };
  };
  const diff = (path, added, removed = []) =>
    [`--- a/${path}`, `+++ b/${path}`, "@@ -1,3 +1,6 @@", ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join("\n");
  const notes = "# House log\n\n## Nov 9\n\nSmoke alarms tested; all four fine.\n\n## Nov 2\n\nGutters cleared before the storm.";
  const plan = (doneCount) =>
    ["Read last night's backup log", "Compare it with last week's", "Move the cache out of the backup", "Write the house log entry"].map((step, i) => ({ step, status: i < doneCount ? "completed" : i === doneCount ? "in_progress" : "pending" }));

  // Results go through each kind's adapter (kinds.js): a result without an error flag
  // is "done" only when it carries what the kind's adapter needs.
  const xc = (text) => `<<<EXTERNAL_UNTRUSTED_CONTENT source="web_fetch">>>\n${text}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT>>>`;
  const t3sc = (sc) => `structuredContent:\n${JSON.stringify(Object.fromEntries(Object.entries(sc).sort(([a], [b]) => a.localeCompare(b))))}`;
  S.t3Thread = "mcp:6f0c2b1e-9d4a-4c31-b8f7-2a5e0d91c4aa";
  S.t3ThreadLink = `https://t3.example/threads/env-home/${S.t3Thread}`;
  const t3 = (id, tool, args, sc, more = {}) =>
    call(id, `t3code__${tool}`, args, {
      mcp: { server: "t3code", tool },
      details: { mcpServer: "t3code", mcpTool: tool, structuredContent: sc },
      text: t3sc(sc),
      ...more,
    });

  S.calls = {
    read: call("call_7a01", "read", { path: "logs/backup-2026-11-15.log" }, { text: S.log, details: { kind: "file", content: "" }, took: "0.6s" }),
    read2: call("call_7a02", "read", { path: "notes/house-log.md" }, { text: notes, took: "0.2s" }),
    readFail: call("call_7a03", "read", { path: "logs/backup-2026-11-08.log" }, { status: "failed", isError: true, text: "ENOENT: no such file or directory, open 'logs/backup-2026-11-08.log'", took: "0.1s" }),
    list: call("call_7a04", "ls", { path: "logs/archive" }, { text: "backup-2026-10-25.log.gz\nbackup-2026-11-01.log.gz\nbackup-2026-11-08.log.gz\nprune-2026-11.log.gz\nREADME", details: { content: "backup-2026-10-25.log.gz\n…" }, took: "0.2s" }),
    edit: call("call_7a05", "edit", { path: "notes/house-log.md", edits: [{ oldText: "# House log\n", newText: "# House log\n\n## Nov 16\n\nThe backup ran long: 71 minutes, not 23.\nThe transcode cache was moved out of it." }] }, {
      text: "Edited notes/house-log.md.",
      details: { changed: true, diff: diff("notes/house-log.md", ["", "## Nov 16", "", "The backup ran long: 71 minutes, not 23.", "The transcode cache was moved out of it."]), firstChangedLine: 2, patch: "" },
      took: "0.3s",
    }),
    create: call("call_7a06", "write", { path: "notes/backup-exclude.md", content: "transcode-cache/\nthumbnails/\n" }, {
      text: "Wrote 2 lines to notes/backup-exclude.md.",
      details: { changed: true, created: true, diff: diff("notes/backup-exclude.md", ["transcode-cache/", "thumbnails/"]), firstChangedLine: 1, patch: "" },
      took: "0.2s",
    }),
    patch: call("call_7a07", "apply_patch", { input: "*** Begin Patch\n*** Update File: scripts/weekly.sh\n@@\n-EXCLUDE=\n+EXCLUDE=transcode-cache\n*** Add File: scripts/exclude.list\n+transcode-cache\n*** Update File: test/exclude.bats\n@@\n+@test \"cache is excluded\" { run ./weekly.sh --dry-run; }\n*** End Patch" }, {
      text: "Applied 3 changes.",
      details: { changed: true, diff: diff("scripts/weekly.sh", ["EXCLUDE=transcode-cache", "transcode-cache", "@test \"cache is excluded\""], ["EXCLUDE="]) },
      took: "0.2s",
    }),
    memory: call("call_7a08", "write", { path: "memory/2026-11-17.md", content: "Dana wants the boiler serviced in October, never once the heating season starts." }, {
      text: "Wrote 1 line to memory/2026-11-17.md.",
      details: { changed: true, created: true, diff: diff("memory/2026-11-17.md", ["Dana wants the boiler serviced in October, never once the heating season starts."]), firstChangedLine: 1, patch: "" },
      took: "0.1s",
    }),
    recall: call("call_7a09", "memory_search", { query: "boiler service" }, {
      text: "2 results.",
      details: { results: [{ path: "memory/2026-11-12.md", snippet: "The boiler was last serviced in October 2025.", score: 0.82 }, { path: "memory/2026-10-03.md", snippet: "Engineer: ask for the annual gas safety record.", score: 0.61 }] },
      took: "0.3s",
    }),
    recallGet: call("call_7a10", "memory_get", { path: "memory/2026-11-12.md" }, { text: "The boiler was last serviced in October 2025. The engineer left the record in the blue folder.", took: "0.1s" }),
    recallPartial: call("call_7a50", "memory_search", { query: "gutters" }, { text: "1 result.", details: { results: [{ path: "memory/2026-09-30.md", snippet: "Gutters cleared before the storm.", score: 0.7 }], partial: true }, took: "5.0s" }),
    recallUnavailable: call("call_7a51", "memory_search", { query: "loft insulation" }, {
      text: "Memory search is unavailable.",
      details: { results: [], disabled: true, unavailable: true, warning: "Memory search is unavailable for this bot", action: "Enable memory search for this bot, then retry." },
      took: "0.1s",
    }),
    command: call("call_7a11", "exec", { command: "du -sh /srv/media/*", workdir: "/srv/media", host: "media-box" }, {
      commandBearing: true,
      text: "182G\t/srv/media/transcode-cache\n640G\t/srv/media/films\n211G\t/srv/media/series",
      details: { status: "completed", exitCode: 0, exitSignal: null, exitReason: "exit", durationMs: 1200, aggregated: "", noOutputTimedOut: false, cwd: "/srv/media" },
      took: "1.2s",
    }),
    exit1: call("call_7a12", "exec", { command: "grep -c transcode /etc/backup/exclude", workdir: "/srv/media", host: "media-box" }, {
      commandBearing: true,
      text: "0\n\n(Command exited with code 1)",
      details: { status: "completed", exitCode: 1, exitSignal: null, exitReason: "exit", durationMs: 100, aggregated: "", noOutputTimedOut: false, cwd: "/srv/media" },
      took: "0.1s",
    }),
    timeout: call("call_7a13", "exec", { command: "rsync -a /srv/media/ nas:/backups/media-box/", host: "media-box", timeoutSeconds: 120 }, {
      commandBearing: true,
      status: "failed",
      failWord: "Timed out",
      timedOut: true,
      isError: true,
      text: "Command timed out after 120 seconds.",
      details: { status: "failed", timedOut: true, failureKind: "overall-timeout" },
      took: "120s",
    }),
    mv: call("call_7a14", "exec", { command: S.command, workdir: "/srv/media", host: "media-box" }, { commandBearing: true, details: { status: "completed", exitCode: 0 } }),
    rm: call("call_7a15", "exec", { command: "rm -rf /srv/media/transcode-cache", host: "media-box" }, { commandBearing: true, status: "blocked", text: "exec denied: host=media-box security=deny", details: { status: "failed" } }),
    terminalList: call("call_7a52", "terminal", { action: "list" }, { text: '{"sessions":[{"sessionId":"term-2","title":"zsh"}]}', details: { sessions: [{ sessionId: "term-2", title: "zsh" }] }, took: "0.1s" }),
    terminalInput: call("call_7a53", "terminal", { action: "input", sessionId: "term-2" }, { text: "ok", took: "0.3s" }),
    web: call("call_7a16", "web_search", { query: "cold climate heat pump performance", count: 5 }, {
      text: "5 results for cold climate heat pump performance.",
      details: {
        kind: "web_search_results",
        provider: "scripted",
        query: "cold climate heat pump performance",
        count: 5,
        tookMs: 2100,
        results: [
          { title: "Heat pumps below freezing: what the field data says", url: "https://energy.example.org/cold-climate" },
          { title: "A winter with an air-source heat pump", url: "https://blog.example.net/winter-heat-pump" },
          { title: "Rated output at −15 °C, model by model", url: "https://ratings.example.com/low-temp" },
          { title: "Backup heat: when it switches on", url: "https://help.example.org/backup-heat" },
          { title: "Ask a heating engineer", url: "https://forum.example.net/t/heat-pump-cold" },
        ],
      },
      took: "2.1s",
    }),
    web2: call("call_7a17", "web_search", { query: "heat pump rebate 2026", count: 5 }, { text: "3 results.", details: { kind: "web_search_results", provider: "scripted", query: "heat pump rebate 2026", count: 3, tookMs: 1700, results: [{ title: "Rebates for 2026", url: "https://grants.example.org/2026" }, { title: "How to apply", url: "https://grants.example.org/apply" }, { title: "Installer list", url: "https://grants.example.org/installers" }] }, took: "1.7s" }),
    xsearch: call("call_7a18", "x_search", { query: "heat pump rebate 2026 experiences" }, {
      text: "Posts mention a six-week wait for the rebate and a required installer certificate.",
      details: { query: "heat pump rebate 2026 experiences", provider: "xai", tookMs: 3400, content: "Posts mention a six-week wait…", citations: ["https://x.example/a/1", "https://x.example/b/2", "https://x.example/c/3", "https://x.example/d/4"] },
      took: "3.4s",
    }),
    xsearchUnavailable: call("call_7a54", "x_search", { query: "heat pump rebate 2026 experiences" }, {
      text: '{"error":"missing_xai_api_key"}',
      details: { error: "missing_xai_api_key", message: "x_search needs xAI credentials. Sign in on the gateway, then retry." },
      took: "0.0s",
    }),
    page: call("call_7a19", "web_fetch", { url: "https://energy.example.org/cold-climate", extractMode: "text" }, {
      text: xc("Heat pumps below freezing\n\nField data from 40 homes shows output holding to about 80% at −10 °C…"),
      details: { title: xc("Heat pumps below freezing"), finalUrl: "https://energy.example.org/cold-climate", status: 200, text: "Field data from 40 homes…", truncated: false },
      took: "0.9s",
    }),
    browserOpen: call("call_7a20", "browser", { action: "open", targetUrl: "https://shop.example/basket" }, { text: "Opened tab 2.", took: "1.4s" }),
    browserClick: call("call_7a21", "browser", { action: "act", request: { kind: "click", ref: "e14", text: "Add to basket" } }, { page: "shop.example", text: "Clicked e14.", took: "0.6s" }),
    browserType: call("call_7a22", "browser", { action: "act", request: { kind: "type", ref: "e20", text: "AB1 2CD" } }, { page: "shop.example", text: "Typed into e20.", took: "0.4s" }),
    browserShot: call("call_7a23", "browser", { action: "screenshot" }, { page: "shop.example", text: "Screenshot saved.", took: "0.8s" }),
    computerShot: call("call_7a24", "computer", { action: "screenshot", node: "study-mac" }, { text: "Screenshot taken.", details: { frameId: "f12" }, took: "0.7s" }),
    computerClick: call("call_7a25", "computer", { action: "left_click", coordinate: [412, 220], node: "study-mac" }, { text: "Clicked.", details: { effect: "confirmed" }, took: "0.3s" }),
    computerUnconfirmed: call("call_7a26", "computer", { action: "left_click", coordinate: [140, 88], node: "study-mac" }, { text: "Clicked; no change was observed.", details: { effect: "suspected_noop" }, took: "0.4s" }),
    phoneObserve: call("call_7a55", "mobile_ui", { action: "observe", node: "dana-phone" }, { text: "Snapshot s4.", details: { snapshotId: "s4" }, took: "0.8s" }),
    phoneTap: call("call_7a56", "mobile_ui", { action: "act", node: "dana-phone", snapshotId: "s4", mobileAction: { type: "tap", ref: "n12" }, confirmed: true }, { text: "Tapped.", took: "0.5s" }),
    screen: call("call_7a57", "screen", { action: "desktop_show", environmentId: "env-1" }, { text: "Shown.", took: "0.2s" }),
    routine: call("call_7a27", "automations", { action: "add", job: { name: "Weekly cleanup", schedule: { kind: "cron", expr: "0 9 * * 1", tz: "Europe/London" }, sessionTarget: "isolated", wakeMode: "now", payload: { kind: "agentTurn", message: "Clear the transcode cache in /srv/scratch." } } }, { text: "Created routine Weekly cleanup.", details: { id: "job_3f2a", name: "Weekly cleanup", enabled: true }, took: "0.2s" }),
    routineRemove: call("call_7a28", "automations", { action: "remove", id: "job_1b07", name: "Old reminder" }, { text: "Removed.", details: { ok: true, removed: true }, took: "0.1s" }),
    routineRun: call("call_7a58", "automations", { action: "run", id: "job_3f2a", name: "Weekly cleanup" }, { text: "Not finished yet.", details: { enqueued: true, runId: "cron_run_7", note: "Not finished yet: it is still running, or it runs after this turn." }, took: "0.4s" }),
    tasks: call("call_7a29", "sessions_list", { limit: 5 }, { text: "5 sessions.", details: { count: 5, sessions: [], hasMore: false, nextOffset: 5, limitApplied: 5 }, took: "0.1s" }),
    history: call("call_7a30", "sessions_history", { sessionKey: "agent:marlow:main", limit: 20 }, { botName: "Marlow", taskTitle: "House log tone", text: "20 messages.", took: "0.2s" }),
    helper: call("call_7a31", "sessions_spawn", { label: "Price check", task: "Find the current price of the three heat pumps on the shortlist and report back in a table." }, {
      text: "Accepted.",
      details: { status: "accepted", childSessionKey: "agent:otto:subagent:price-check", runId: "run_c41e", mode: "run" },
      took: "0.3s",
    }),
    wait: call("call_7a32", "agents_wait", { ids: ["sub_1", "sub_2"], timeoutSeconds: 300 }, { text: "Both finished.", took: "48s" }),
    question: call("call_7a33", "ask_user", { questions: [{ question: "Which route should I plan for Saturday?" }], timeoutSeconds: 900 }, { text: "Route: The coast road", took: "1m 12s" }),
    plan: call("call_7a34", "progress_card", { plan: plan(0) }, { text: "Saved the plan.", details: { revision: 1, steps: {} }, took: "0.1s" }),
    planUpdate: call("call_7a35", "progress_card", { plan: plan(2) }, { update: true, text: "Saved the plan.", details: { revision: 3, steps: {} }, took: "0.1s" }),
    goalGet: call("call_7a59", "get_goal", {}, { text: "Goal: cut the weekly backup back under 30 minutes.", took: "0.1s" }),
    goalUpdate: call("call_7a60", "update_goal", { status: "complete" }, { text: "Updated.", took: "0.1s" }),
    image: call("call_7a36", "image_generate", { action: "generate", prompt: "A small house in snow with a heat pump outside, flat illustration", count: 1 }, {
      text: "Background task started for image generation (task_91a2).",
      details: { async: true, status: "started", taskId: "task_91a2", runId: "tool:image_generate:91a2", task: { taskId: "task_91a2", runId: "tool:image_generate:91a2" } },
      took: "0.4s",
    }),
    imageMade: call("call_7a61", "image_generate", { action: "generate", prompt: "The same house, at dusk", count: 2 }, {
      text: "Made 2 images.",
      details: { count: 2, media: { mediaUrls: ["media/house-dusk-1.png", "media/house-dusk-2.png"] }, paths: ["media/house-dusk-1.png", "media/house-dusk-2.png"] },
      took: "11.2s",
    }),
    voice: call("call_7a37", "tts", { text: "Your boiler service is booked for the third of October." }, { text: "Made 1 clip.", details: { audioPath: "media/reminder.mp3", media: { mediaUrl: "media/reminder.mp3" } }, took: "2.2s" }),
    pdf: call("call_7a62", "pdf", { pdfs: ["house/epc-2023.pdf", "house/quote-2024.pdf", "house/survey.pdf"], prompt: "What rating and what heating does each one give?" }, { text: "EPC 2023: D (61), gas boiler…", took: "6.1s" }),
    images: call("call_7a63", "view_image", { paths: ["photos/loft-1.jpg", "photos/loft-2.jpg"], prompt: "How deep is the insulation?" }, { text: "About 100 mm in both.", took: "3.0s" }),
    channel: call("call_7a38", "conversations_send", { conversationRef: "conv_tg_51c2", message: "The backup is fixed. Tonight's run should take about 20 minutes." }, {
      text: '{"status":"queued"}',
      details: { status: "queued", conversationRef: "conv_tg_51c2", channel: "Telegram", queueId: "q_88" },
      took: "0.6s",
    }),
    channelSent: call("call_7a64", "conversations_send", { conversationRef: "conv_tg_51c2", message: "Survey booked for Dec 2." }, { text: '{"status":"sent"}', details: { status: "sent", conversationRef: "conv_tg_51c2", channel: "Telegram", messageId: "m_302" }, took: "0.5s" }),
    channelSuppressed: call("call_7a65", "conversations_send", { conversationRef: "conv_tg_51c2", message: "Reminder: survey tomorrow." }, { text: '{"status":"suppressed"}', details: { status: "suppressed", conversationRef: "conv_tg_51c2", channel: "Telegram" }, took: "0.2s" }),
    message: call("call_7a66", "message", { action: "send", channel: "Telegram", target: "Dana", message: "Heat pump survey booked for Dec 2." }, { text: "ok", took: "0.6s" }),
    server: call("call_7a39", "linear__create_issue", { title: "Exclude the transcode cache from the weekly backup", team: "Home" }, { mcp: { server: "linear", tool: "create_issue" }, text: "structuredContent:\n{\"id\":\"HOME-42\"}\n\nCreated HOME-42.", details: { mcpServer: "linear", mcpTool: "create_issue", structuredContent: { id: "HOME-42" } }, took: "0.9s" }),
    general: call("call_7a40", "skills_search", { query: "invoice" }, { builtin: true, title: "Skill Search", text: "2 skills match.", took: "0.4s" }),
    general2: call("call_7a41", "getWeatherNow", { location: "Leeds" }, { text: "4 °C, light rain.", took: "0.5s" }),
    general3: call("call_7a42", "github_publish", { title: "Backup exclude list", path: "notes/backup-exclude.md" }, { builtin: true, title: "GitHub Publish", text: "Published.", took: "1.8s" }),

    // T3 Code, with its own tool names and result shapes (section 11.1).
    t3Launch: t3("call_01HXK9T", "t3_thread_launch", { projectId: "proj_backup", title: "Exclude the transcode cache", message: S.t3Sent, workspaceStrategy: { type: "worktree", baseRef: "main", branch: "exclude-cache" } }, { threadId: S.t3Thread, link: S.t3ThreadLink, projectId: "proj_backup", modelSelection: { instanceId: "coder", model: "coder-large" }, runId: "run_t3_1", status: "running" }, { took: "0.8s" }),
    t3Wait: t3("call_01HXKA2", "t3_thread_wait", { threadId: S.t3Thread, timeoutMs: 50000 }, { threadId: S.t3Thread, runId: "run_t3_1", status: "running", timedOut: true }, { took: "50s" }),
    t3Send: t3("call_01HXM2A", "t3_thread_send", { threadId: S.t3Thread, message: S.t3Followup }, { threadId: S.t3Thread, link: S.t3ThreadLink, messageId: "msg_2", runId: "run_t3_1", status: "running", delivery: "steered" }, { took: "0.5s" }),
    t3ReadFail: t3("call_01HXM7D", "t3_thread_read", { threadId: S.t3Thread }, { code: "orchestration_error", message: "The thread store did not answer." }, { status: "failed", isError: true, took: "0.3s" }),
    t3Read: t3("call_01HXM7C", "t3_thread_read", { threadId: S.t3Thread, runLimit: 1 }, {
      thread: { threadId: S.t3Thread, title: "Exclude the transcode cache", link: S.t3ThreadLink, status: "completed", latestRunId: "run_t3_1", activeRunId: null, settled: true },
      recentRuns: [{ runId: "run_t3_1", status: "completed" }],
      items: [{ position: 7, itemId: "it_7", runId: "run_t3_1", type: "assistant_message", text: "Added the exclude and a guard to weekly.sh, with a test for the guard. Opened a pull request with both changes." }],
      nextPosition: null,
      hasMore: false,
    }, { took: "0.6s" }),
    t3Stop: t3("call_01HXM9F", "t3_thread_interrupt", { threadId: S.t3Thread, stop: true }, { threadId: S.t3Thread, runId: "run_t3_1", status: "interrupt_requested" }, { took: "0.4s" }),
    t3Projects: t3("call_01HXL01", "t3_project_list", { limit: 20 }, { projects: [{ id: "proj_backup", title: "backup-scripts" }, { id: "proj_site", title: "house-site" }, { id: "proj_recipes", title: "recipes" }, { id: "proj_notes", title: "notes" }], nextCursor: null }),
    t3Threads: t3("call_01HXL02", "t3_thread_list", { projectId: "proj_backup" }, { projectId: "proj_backup", currentThreadId: null, threads: [{ threadId: S.t3Thread, title: "Exclude the transcode cache", status: "running" }, { threadId: "mcp:22c1", title: "Faster prune", status: "completed" }], nextCursor: null, total: 2 }),
  };

  // A run's reasoning, attached to the action it led to.
  S.reasonings = {
    beforeRead2: { time: "4s", text: "71 minutes instead of the usual 23. The transfer line is the odd one: 187 GB, where a normal week moves about 5. I should compare with last week's log before I blame the network." },
    beforeReply: { time: "8s", text: "The user asks whether a heat pump is worth it in a cold, damp town. I know the general answer: it depends on insulation and the size of the unit.\n\nThe honest reply is a short yes-if, with the two things to check first." },
  };

  S.turnErrorRaw = {
    events: [["Event (a sample in the app's own shape)", json({ type: "chat", state: "error", runId: "run_7f3a91c2", error: { code: "provider_overloaded", message: "The model provider is overloaded.", requestId: "req_9c1e44a0" } })]],
    ids: [["Request", "req_9c1e44a0"], ["Run", "run_7f3a91c2"], ["Session", "agent:otto:weekly-backup-check"]],
  };
})();
