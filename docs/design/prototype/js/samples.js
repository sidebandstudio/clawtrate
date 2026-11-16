// Sample content shared by the gallery and the scripted conversation.
// Everything here is invented: the bots, the machine, the log, the commands.

(function () {
  const CT = window.CT;
  const S = (CT.samples = {});

  S.log = [
    "02:14:03 backup: start profile=weekly target=nas:/backups/media-box",
    "02:14:03 backup: snapshot 2026-11-15 parent=2026-11-08",
    "02:14:09 scan: 48,112 files changed since parent",
    "02:14:09 scan: /srv/media/transcode-cache 41,870 files 182.4 GB (new)",
    "02:31:40 transfer: 96.1 GB of 187.3 GB",
    "02:58:12 transfer: 171.0 GB of 187.3 GB",
    "03:24:51 transfer: done 187.3 GB in 70m 42s",
    "03:25:02 prune: kept 12 snapshots",
    "03:25:03 backup: finished ok",
    "03:25:03 backup: next run 2026-11-17 02:14",
  ].join("\n");

  S.ids = (call) => [
    ["Tool call", call],
    ["Item", `tool:${call}`],
    ["Run", "run_7f3a91c2"],
    ["Session", "agent:otto:weekly-backup-check"],
  ];

  S.readRaw = {
    tool: "read",
    args: '{\n  "path": "logs/backup-2026-11-15.log"\n}',
    result:
      '{\n  "content": [\n    {\n      "type": "text",\n      "text": "02:14:03 backup: start profile=weekly target=nas:/backups/media-box\\n02:14:03 backup: snapshot 2026-11-15 parent=2026-11-08\\n02:14:09 scan: 48,112 files changed since parent\\n…"\n    }\n  ],\n  "details": {\n    "path": "logs/backup-2026-11-15.log",\n    "lines": 214,\n    "bytes": 18432\n  },\n  "isError": false\n}',
    clipped: true,
    lines: 14,
    timing: [
      ["Started", "5:24:07 PM"],
      ["Ended", "5:24:08 PM"],
      ["Took", "0.6 s"],
    ],
    ids: S.ids("call_01HXK2"),
  };

  S.readBody = (view = "readable") =>
    CT.stepBody({
      view,
      readable:
        CT.fields([["File", "logs/backup-2026-11-15.log", { mono: true, copy: true }]]) +
        CT.codeBlock({ label: "Result", text: S.log, clipped: true, lines: 214 }),
      raw: S.readRaw,
    });

  S.failedBody = () =>
    CT.stepBody({
      readable:
        CT.fields([["File", "logs/backup-2026-11-08.log", { mono: true }]]) +
        CT.codeBlock({
          label: "Error",
          text: "ENOENT: no such file or directory, open 'logs/backup-2026-11-08.log'",
          tone: "danger",
        }),
      raw: {
        tool: "read",
        args: '{\n  "path": "logs/backup-2026-11-08.log"\n}',
        error: "ENOENT: no such file or directory, open 'logs/backup-2026-11-08.log'",
        timing: [
          ["Started", "5:24:19 PM"],
          ["Ended", "5:24:19 PM"],
          ["Took", "0.1 s"],
        ],
        ids: S.ids("call_01HXK4"),
      },
    });

  S.thoughtText =
    "71 minutes instead of the usual 23. The transfer line is the odd one: 187 GB, where a normal week moves about 5. Something large and new got included. I should compare with last week's log before I blame the network.";

  S.thoughtBody = (view = "readable") =>
    CT.stepBody({
      view,
      readable: `<p class="step-thought">${S.thoughtText}</p>`,
      raw: {
        event:
          '{\n  "stream": "thinking",\n  "runId": "run_7f3a91c2",\n  "seq": 14,\n  "ts": 1794878651204,\n  "data": {\n    "text": "71 minutes instead of the usual 23. The transfer line is the odd one: 187 GB, where a normal week moves about 5. …"\n  }\n}',
        ids: [
          ["Run", "run_7f3a91c2"],
          ["Session", "agent:otto:weekly-backup-check"],
        ],
      },
    });

  S.commandText = "mv /srv/media/transcode-cache /srv/media/transcode-cache.old && df -h /srv/media";

  S.commandOutput =
    "Filesystem      Size  Used Avail Use% Mounted on\n/dev/sdb1       1.8T  1.1T  640G  64% /srv/media";

  S.commandBody = (live = false) =>
    CT.stepBody({
      readable:
        CT.fields([
          ["Command", S.commandText, { mono: true, copy: true }],
          ["Runs on", "media-box"],
          ["Folder", "/srv/media", { mono: true }],
        ]) +
        CT.codeBlock({
          label: live ? "Output so far" : "Output",
          copy: "output",
          text: live ? S.commandOutput.split("\n")[0] + "\n" : S.commandOutput,
          live,
        }),
      raw: {
        tool: "exec",
        args: `{\n  "command": "${S.commandText}",\n  "cwd": "/srv/media",\n  "host": "media-box"\n}`,
        result: live ? "" : '{\n  "content": [{ "type": "text", "text": "Filesystem      Size  Used Avail Use% Mounted on\\n/dev/sdb1       1.8T  1.1T  640G  64% /srv/media" }],\n  "details": { "exitCode": 0, "cwd": "/srv/media" },\n  "isError": false\n}',
        timing: live
          ? [["Started", "5:25:02 PM"]]
          : [
              ["Started", "5:25:02 PM"],
              ["Ended", "5:25:03 PM"],
              ["Took", "1.2 s"],
            ],
        ids: S.ids("call_01HXKB"),
      },
    });

  S.approval = {
    bot: "otto",
    what: "run a command",
    summary: "Move the transcode cache aside on <b>media-box</b>, so tonight's backup skips it.",
    full: {
      reason:
        "The command moves a folder under /srv/media. Otto asks before any command that changes files outside its own workspace.",
      command: S.commandText,
      fields: [
        ["Runs on", "media-box"],
        ["Folder", "/srv/media", { mono: true }],
        ["Asked by", "Your message in this task, 5:24 PM"],
      ],
    },
    standing: { rule: "/bin/mv, any arguments, on media-box" },
  };

  S.marlowSent =
    "Write a two-line entry for the house log. Last night's backup took 71 minutes instead of 23, because the transcode cache (182 GB) was included. I am excluding it from tonight's run.";

  S.marlowReply =
    "<p><strong>Nov 16.</strong> Last night's backup ran long: 71 minutes, not the usual 23, because 182 GB of transcode cache was swept in.</p><p>The cache is now excluded, so tonight's run should be back to normal.</p>";

  S.t3Sent =
    "In backup-scripts, add /srv/media/transcode-cache to the exclude list in weekly.sh. Also add a check that fails the run when an excluded path shows up in the transfer list.";

  S.messagedRaw = (tool = "sessions_send") => CT.linkButton("Raw", { tone: "muted" });

  // The expanded body of a Messaged card to another bot.
  S.marlowBody = (stage) =>
    CT.exchange([
      { who: "otto", verb: "sent", time: "5:24 PM", html: `<div class="exchange-text"><p>${S.marlowSent}</p></div>` },
      stage === "replied"
        ? { who: "marlow", verb: "replied", time: "5:25 PM", html: `<div class="exchange-text">${S.marlowReply}</div>` }
        : stage === "failed"
          ? {
              who: "marlow",
              verb: "did not answer",
              time: "",
              html: `<p class="exchange-note">Marlow's run failed: the model provider was overloaded. Nothing was written.</p>`,
            }
          : {
              who: "marlow",
              verb: "is on it",
              time: "",
              html:
                `<div class="exchange-wait">${CT.presence("marlow", "working", { label: false })}` +
                `<span>Reading the house log</span></div>`,
            },
    ]) +
    CT.cardActions(
      CT.linkButton("Open in Marlow", { icon: "external" }) +
        CT.linkButton("Open full exchange") +
        `<span class="spacer"></span>` +
        CT.linkButton("Raw", { tone: "muted" }),
    );

  // The expanded body of a Messaged T3 Code card.
  S.t3Body = (stage, { stopped = false } = {}) =>
    CT.exchange([
      {
        who: "otto",
        verb: "sent",
        time: "5:24 PM",
        html:
          `<div class="exchange-text"><p>${S.t3Sent}</p></div>` +
          `<div class="chips"><span class="chip"><span>Project</span>backup-scripts</span>` +
          `<span class="chip"><span>Branch</span>main</span></div>`,
      },
      stage === "done"
        ? {
            who: "t3code",
            verb: "finished",
            time: "5:41 PM",
            html:
              `<div class="exchange-text"><p>Added the exclude and a guard to weekly.sh, with a test for the guard. Opened a pull request with both changes.</p></div>` +
              `<div class="chips"><span class="chip">${CT.icon("file")}weekly.sh</span><span class="chip">${CT.icon("file")}test/exclude.bats</span></div>`,
          }
        : stage === "failed"
          ? {
              who: "t3code",
              verb: "did not accept it",
              time: "5:24 PM",
              html: CT.codeBlock({ label: "Error", text: "connect ECONNREFUSED: the coding agent's server did not answer", tone: "danger" }),
            }
          : {
              who: "t3code",
              verb: "accepted",
              time: "5:24 PM",
              html:
                `<p class="exchange-note">Thread 18. No result yet. This card changes only if Otto checks on the work.</p>` +
                (stopped ? `<p class="exchange-note"><b>Work already sent to T3 Code continues there.</b></p>` : ""),
            },
    ]) +
    CT.cardActions(
      (stage === "failed" ? "" : CT.linkButton("Open thread", { icon: "external" })) +
        `<span class="spacer"></span>` +
        CT.linkButton("Raw", { tone: "muted" }),
    );
})();
