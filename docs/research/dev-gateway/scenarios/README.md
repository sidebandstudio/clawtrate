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
OPENCLAW_DEV_TOKEN="$(cat "$RUN_DIR/token")" node questions.mjs
```

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
