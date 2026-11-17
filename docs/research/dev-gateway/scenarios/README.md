# Probe scenarios

These are the scripts behind row 19 of `docs/research/gateway-capabilities.md`.
They are research code. Each one prints what it saw and does not assert
anything.

They need a gateway started by `../dev-gateway.sh` from `../openclaw.dev.json`.
The bots must be `atlas` and `pixel`, with the `coder` MCP server
(`../fake-coding-mcp.mjs`) and the scripted model (`../fake-openai.mjs`).

To run them, copy `../probe-lib.mjs` and the scenarios into a scratch folder
where `@openclaw/gateway-client@2026.10.6` is installed, then:

```bash
OPENCLAW_DEV_RUN_DIR="$RUN_DIR" \
OPENCLAW_DEV_STATE="$HOME/.openclaw-<profile>" node questions.mjs
```

`probe-lib.mjs` refuses to connect unless all of these hold:
- the target is `ws://127.0.0.1:19101`;
- the run folder holds the launcher's `token`, `gateway.pid` and
  `fake.pid`;
- the state folder carries the launcher's marker;
- the gateway reports 2026.10.6;
- every model of every agent is the scripted fake.

Scenarios that answer approvals resolve only requests raised in sessions they
created. Scenarios that change config restore the exact original value in a
`finally` block and fail if it differs (`withAgentExecPolicy` in
`probe-lib.mjs`). Waits that time out throw; they are never reported as an
absence. Node scenarios act only on the fixture node named by
`PROBE_NODE_NAME`.

| Script | Row 19 topic |
| --- | --- |
| `questions.mjs`, `questions-plain-text.mjs` | question cards: answer, multiple choice with free text, dismiss, plain-text answer |
| `queue-modes.mjs`, `steer-run-ids.mjs` | queue modes during streaming and during a tool call |
| `timeouts-abort-approvals.mjs` | run timeout, aborting a hung MCP tool, pending approvals |
| `compact-reset.mjs` | `/compact`, `/new`, `/reset`, `sessions.reset`, `sessions.compact` |
| `compaction-success.mjs` | a successful `/compact`. It **changes the profile's** `compaction.mode` to `default`, so reset the profile afterwards |
| `reasoning-order.mjs` | reasoning, tool and text event order |
| `tool-errors-output.mjs` | exec timeout, non-zero exit, long output |
| `bot-to-bot-states.mjs`, `late-reply.mjs`, `late-reply-rows.mjs` | `sessions_send` recipient states and late replies |
| `metadata.mjs`, `search.mjs` | `users.prefs`, reactions, reply references, time fields, `sessions.search` |
| `attachments.mjs` | image, file and frame ceilings |
| `talk-selection.mjs` | Talk bot selection by session key |
| `questions-expiry-abort-scope.mjs` | a read+write device's refused question calls and missing events; 30 s expiry; abort while asking |

Row 20 scripts:

| Script | Row 20 topic |
| --- | --- |
| `members-mcpcancel-settings.mjs` | `node … members`: agents as session members; `mcpcancel`: MCP `notifications/cancelled`; `settings [permissionMode,configFull,sessionsPatchExecAsk]`: settings changes during a pending approval |
| `helper-and-recipient-approvals.mjs` | `helper` / `recipient`: whether a sub-agent or a `sessions_send` recipient raises an exec card; reports `CARD`, `FAILED` (quoting the child transcript) or `UNKNOWN`, never a bare "none" |
| `files-computer-presence.mjs` | workspace, session files, diff, artifacts, `computer.status`, nodes, presence |
| `node-pairing-hoststats.mjs` | approves the fixture node named by `PROBE_NODE_NAME` and waits for its `node.hostStats`; refuses an ambiguous name and touches no other node |
| `node-routed-exec.mjs` | routes one task's exec to the fixture node (`PROBE_NODE_NAME`) and runs `pwd`; resolves only its own task's approval |
| `exec-auto-review.mjs` | `exec.mode: "auto"` allow and deny verdicts with the scripted reviewer (not ask, failure or escalation); restores Atlas's exact exec block |
| `memory-save-search.mjs` | a bot writing memory, `memory.status`, `memory.search` |
| `usage-fields.mjs`, `effort-and-models.mjs` | usage result fields; effort per turn and `models.list` details |
| `paired-devices.mjs` | fields of paired client devices |

Row 21 scripts:

| Script | Row 21 topic |
| --- | --- |
| `routines.mjs` | create, run now, approval from the run and its standing grant, pause, refused runs, remove, `cron` events |
| `routine-history.mjs` | a routine with delivery off: `finished` event, run log, `cron.history`, run session listing |
| `web-push.mjs` | Web Push subscribe from a non-browser client (endpoint on a closed loopback port), preferences, presence fields |
| `skills-library-and-workshop.mjs` | the bot's `skill_workshop` tool, library disable and remove |
| `mcp-servers.mjs` | catalog, adding a command server without a restart, `mcp.authLogin` refusal |
| `secrets-request.mjs` | the bot's `secrets` request and whether the value leaks |
| `client-node.mjs` | a client acting as a node: allowed, custom and unanswered commands |
| `expired-approval.mjs` | "Always allow" on an expired exec approval |
| `credentials-and-tools.mjs` | model auth status, secret store listing, `image_generate` in the bot's tools |
