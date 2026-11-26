# Which tool opened a session

Observed on development gateways running OpenClaw 2026.10.6, and read in its source (`session-creation-provenance-*.mjs`, `session-row-prepared-read-*.mjs`, `http-utils-*.mjs`, `run-session-state-*.mjs`). It settles how Clawtrate tells a session the person started from one another tool opened (F-563, `packages/core/src/origins.ts`).

## What a session row records

- **`createdVia`**, set once when the gateway creates the session and never changed by later turns. The protocol's values are `operator`, `spawn`, `channel`, `cron`, `talk`, `run`, `plugin` and `internal`.
  - `sessions.create` and a `chat.send` to a new key from an operator connection record `operator` (`resolveOperatorSessionCreation`), with `createdActor` the person's profile.
  - The `agent` method (the CLI's `openclaw agent`) and the HTTP API's agent runs record `run` (`resolveAgentRunSessionCreation`).
  - A routine's session records `cron`, with `createdActor: {type: "system"}`.
- **`classification`**, the gateway's class of the session's route (`sessionClassificationForRow`), in this order: `global`, `unknown`, `heartbeat`, `main`, `subagent`, `acp`, `cron`, `thread`, `group`, `channel`, `direct`. Otherwise it comes from the key's rest: `dashboard:` → `dashboard`, `tui-` → `tui`, `explicit:` → `explicit`, `hook:` → `hook`, `node-`/`node:` → `node`, `harness:` → `harness`, `voice:` → `voice`, `dreaming-narrative-` → `dreaming`, `boot`/`internal-session-effects:` → `system`, and anything else → `custom`. A session whose `chatType` is `direct` is `direct` before the key is read.
- The gateway's own list filter `excludeSystem` hides machine-made rows from provenance or reserved keys, "never transcript text". Clawtrate already asks for `excludeCron` and `excludeSubagents`.

## What each tool's sessions look like

| Made by | Key | `createdVia` | `createdActor` | `classification` |
| --- | --- | --- | --- | --- |
| Clawtrate's New task (`sessions.create`, no key) | `agent:<bot>:dashboard:<uuid>` | `operator` | the person | `dashboard` |
| An operator's `chat.send` to a new key | as sent, e.g. `agent:main:explicit:script-job` | `operator` | the person | `direct` |
| The HTTP API with a `user` | `agent:<bot>:openai-user:<user>` | none | none | `custom` |
| The HTTP API with `x-openclaw-session-key` | as sent, e.g. `agent:<bot>:explicit:nightly-sync` | none | none | `explicit` |
| The HTTP API with neither | `agent:<bot>:openai:<uuid>` | none | none | `custom` |
| A routine with `sessionTarget: "session:<id>"` | `agent:<bot>:<id>` | `cron` | `{type: "system"}` | `custom` |
| A routine with `sessionTarget: "isolated"` | `agent:<bot>:cron:<job>:run:<id>` | | | `cron`, left out by `excludeCron` |
| The CLI's `openclaw agent` on a new key | as given | `run` | none | `custom` |

The HTTP API builds its keys in `resolveGatewayRequestContext`: `agent:<bot>:<prefix>-user:<user>`, or `agent:<bot>:<prefix>:<uuid>`, with the prefix `openai` (`/v1/chat/completions`) or `openresponses` (`/v1/responses`). A client's own `x-openclaw-session-key` is used as given, and needs an agent-scoped key when several bots exist.

## A session another tool opened that waits for the person

The gateway lets no headless run wait for an approval. The HTTP API's, the CLI's `openclaw agent` and a routine's runs all end the tool call with "exec denied: Headless runs cannot wait for interactive exec approval". A routine's prompt says it is unattended. So such a session waits on an approval only once a person continues it from an interactive client: an operator's `chat.send` turn in it asks, and the session's `createdVia` is still what made it.

## Reaching a routine's run

`cron.runs` names each run's session (`sessionKey`). Clawtrate's Routines page opens an isolated run's conversation in place (F-190), and offers "Open conversation" for a run in a shared session. That opens the session by its key, whether or not the task list holds it.
