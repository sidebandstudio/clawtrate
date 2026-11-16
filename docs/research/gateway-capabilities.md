# OpenClaw gateway capability map

What a Clawtrate client can do against an OpenClaw gateway, checked against the
schema and source that ship with OpenClaw 2026.10.6 and against a running
isolated gateway. Every method and event name below was checked in the shipped
schema or source. Rows also say whether a live call was made.

How to read the citations:

- `<openclaw>/…` is a path inside the installed `openclaw` npm package (find it
  with `npm root -g`, or follow the `openclaw` wrapper script, which runs
  `<openclaw>/dist/entry.js`). Bundled chunk names carry a build hash
  (`server-methods-list-Cv0-xJIK.mjs`). The hash changes every release. Search by the
  `//#region <source path>` marker at the top of each chunk instead.
- `schema` means `protocol.schema.json` in `@openclaw/gateway-protocol@2026.10.6`.
  Its `methods` map gives each core method's required scope and `since`
  release. Its `definitions` give request and result shapes. The gateway
  itself does not ship this file. It bundles the same TypeBox sources, marked
  `//#region packages/gateway-protocol/src/...`.
- "Live" means the call was made against the probe gateway described in
  section 4, with the pinned client, and the result matched the description.
  "Source" means read from shipped code or docs only.
- Docs paths are `<openclaw>/docs/...`. They match docs.openclaw.ai paths
  without the `.md` suffix.

## 1. Versions

### What is installed

| Item | Value | Where checked |
| --- | --- | --- |
| Gateway | `openclaw` 2026.10.6 | `openclaw --version`, `<openclaw>/package.json`, `hello-ok.server.version` (live) |
| Wire protocol | `PROTOCOL_VERSION = 4`, `MIN_CLIENT_PROTOCOL_VERSION = 4`, `MIN_NODE_PROTOCOL_VERSION = 3`, `MIN_PROBE_PROTOCOL_VERSION = 3` | `<openclaw>/dist/version-CwNT1gaY.mjs` (region `packages/gateway-protocol/src/version.ts`), `hello-ok.protocol = 4` (live) |
| Gateway protocol bundle | `<openclaw>/dist/gateway/protocol/index.js` plus the `packages/gateway-protocol/src/schema/*` regions spread across `dist/*.mjs` | source |
| Event list the gateway advertises | `GATEWAY_EVENTS` in `<openclaw>/dist/server-methods-list-Cv0-xJIK.mjs` (region `src/gateway/server-methods-list.ts`) | source, and identical to `hello-ok.features.events` (live) |
| Model adapter library | `<openclaw>/node_modules/@openclaw/ai` 2026.10.6 | source |

### What to pin

Pin **`@openclaw/gateway-client@2026.10.6`** and
**`@openclaw/gateway-protocol@2026.10.6`**, exact versions, both. The client
package depends on the protocol package at exactly the same version.

```bash
pnpm add --save-exact @openclaw/gateway-client@2026.10.6 @openclaw/gateway-protocol@2026.10.6
```

Browser and Expo hosts import `@openclaw/gateway-client/browser`. That entry
supplies the protocol client and device-auth lifecycle without Node built-ins
or `ws`. The host injects the WebSocket, storage and Ed25519 signing.

How this was verified:

1. `npm view @openclaw/gateway-client versions` lists 2026.10.6, published
   the same day as the gateway build. Current dist-tags are `latest`
   2026.11.4, `extended-stable` 2026.9.37 and `beta` 2026.11.5-beta.4.
2. The 2026.9.37, 2026.10.6 and 2026.11.4 tarballs all export
   `PROTOCOL_VERSION = 4` and `MIN_CLIENT_PROTOCOL_VERSION = 4`. The wire
   number alone therefore does not tell those releases apart.
3. The pinned client connected to the probe gateway with
   `minProtocol: 4, maxProtocol: 4` and received `hello-ok` with
   `protocol: 4` (live).
4. Fields added after 2026.10.6 break against this gateway. Request schemas
   are closed (`additionalProperties: false`), and the gateway enforces that.
   Live calls against 2026.10.6:
   - `sessions.list` with `ifRowsRevision` (added in 2026.11.x) returned
     `INVALID_REQUEST: invalid sessions.list params: at root: unexpected property 'ifRowsRevision'`.
   - `agent` with `createSessionIfMissing` (added in 2026.11.x) returned
     `INVALID_REQUEST ... unexpected property 'createSessionIfMissing'`.

The install guide inside the 2026.10.6 docs
(`<openclaw>/docs/gateway/clients.md`, "Install the packages") still names
2026.8.1 as the "verified stable release". That text is stale. 2026.8.1
predates 2026.9 and 2026.10 methods this client needs, such as
`computer.status`, `sessions.processes.list`, `memory.get` and
`cron.history`. Do not follow it.

### What breaks across versions

Diffing the schema between 2026.10.6 and 2026.11.4: no definitions were
removed, 58 were added and 107 changed. All changes were additive fields or
new methods. Methods added in 2026.11.x include `backup.recordOutcome`,
`debugProxy.capture`, `environments.adoptSuggestedProfile`, `mcp.events.list`,
`memory.search.owner`, `openclaw.setup.auto`, `projects.checkoutOptions`,
`secrets.store.allowedHosts`, `secrets.store.import`, `skills.workshop.undo`,
`ui.command.result` and `users.background.*`. Three methods changed scope:
`projects.searchRemote` became `operator.write`, while `users.prefs.set` and
`worktrees.list` changed level. Consequences:

- A newer client sending a newer optional field to an older gateway is
  rejected outright (shown above). This is the main break.
- An older client calling an older gateway with a newer-only method gets an
  unknown-method error. Use `hello-ok.features.methods` and
  `hello-ok.features.capabilities` for feature detection. The methods list is
  conservative. `push.test`, `sessions.usage`, `sessions.steer` and
  `chat.inject` are among the 23 schema methods that are callable but not
  advertised (live comparison of `hello-ok` with the schema)
  (`<openclaw>/docs/gateway/protocol/rpc-methods.md`).
- `HelloOk` is a closed object in the schema, and 2026.11.4 added
  `controlUiBasePath` to it. Whether the 2026.10.6 client rejects unknown
  `hello-ok` fields from a newer gateway is **unverified**. I could not find
  a schema check of inbound frames in the client bundle, and no newer gateway
  was available to test.
- Client ids and modes are closed enums (see section 2, Connect), so a new
  client identity cannot be introduced without an upstream change.

Policy for Clawtrate: pin client and gateway to the same release, record that
release in `docs/decisions.md`, and move both together.

## 2. Capability table

Scopes are the method's base scope from the schema `methods` map unless noted.
"dynamic" means the gateway decides per call. The full operator scope set is
`operator.read`, `operator.write`, `operator.admin`, `operator.approvals`,
`operator.questions`, `operator.pairing`, `operator.talk` and
`operator.talk.secrets` (`<openclaw>/docs/gateway/protocol/handshake.md`).
`sessions.github.publish` alone uses `operator.sessions.write`.

Status key: `available` means the gateway supports the flow today.
`partial` means it works with a gap a client cannot close alone. `missing`
means a plugin is needed.

### Summary

| # | Need | Status |
| --- | --- | --- |
| 1 | Connect, challenge signing, pairing, token reuse, scope upgrade, caps | available |
| 2 | List bots, identity, name, avatar, description | available (description is config-only) |
| 3 | Create, edit, delete a bot with all its settings | partial |
| 4 | Sessions per bot, subscriptions, history, stable ids | available |
| 5 | Send, attach, abort, queue, steer | available (steer caveat) |
| 6 | Streaming text, thinking, run lifecycle | available |
| 7 | Tool events and bot-to-bot cards | available |
| 8 | Approvals | available for exec and plugin approvals; partial for per-bot rules on other tools |
| 9 | Schedules | available |
| 10 | Memory read, edit, delete | partial |
| 11 | Files and artifacts | available |
| 12 | Models and effort | available |
| 13 | Nodes and machine choice | available (not exercised live) |
| 14 | Tool permissions and exec policy per bot | available (admin) |
| 15 | Usage, cost, context window | available |
| 16 | Notifications and mobile push | missing for a third-party iOS app |
| 17 | Voice and talk | available (not exercised live) |
| 18 | The bot's computer: browser, canvas, screens | partial |

### 1. Connect, challenge, pairing, device tokens, scope upgrades, caps

- **Frames.** Request `{type:"req", id, method, params}`, response
  `{type:"res", id, ok, payload|error}`, event
  `{type:"event", event, payload, seq?, stateVersion?}`. Errors are
  `{code, message, details?, retryable?, retryAfterMs?}`. A missing scope is
  `code: "FORBIDDEN"` with
  `details: {code:"MISSING_SCOPE", missingScope, requiredScopes}`
  (`schema` `EventFrame`, `RequestFrame`, `ResponseFrame`,
  `MissingScopeErrorDetails`; live: `chat.send` from a read-only device
  returned `MISSING_SCOPE`, `missingScope: "operator.write"`).
- **Challenge.** The server's first frame is event `connect.challenge`,
  payload `{nonce, ts}`. The client replies with method `connect`, using
  `ConnectParams`: `{minProtocol, maxProtocol, client:{id, version, platform,
  mode, displayName?, deviceFamily?, instanceId?...}, role, scopes, caps,
  auth:{token?|deviceToken?|password?|bootstrapToken?}, device:{id,
  publicKey, signature, signedAt, nonce}, locale?, userAgent?}`. Set
  `signedAt` to the challenge `ts`. `device.id` is the hex SHA-256 of the
  raw 32-byte Ed25519 public key. `publicKey` and `signature` are base64url.
  The preferred signature payload is v3, `buildDeviceAuthPayloadV3` in
  `@openclaw/gateway-client` (source:
  `<openclaw>/dist/device-identity-DHDkFiu6.mjs`,
  `deriveDeviceIdFromPublicKey`; `<openclaw>/docs/gateway/protocol/auth.md`).
  Live: a Node host using the client's `deviceIdentity`,
  `hostDeps.signDevicePayload` and `hostDeps.publicKeyRawBase64UrlFromPem`
  connected successfully.
- **Client identity is a closed enum.** `client.id` must be one of
  `webchat-ui`, `openclaw-control-ui`, `openclaw-browser-copilot`,
  `openclaw-tui`, `webchat`, `cli`, `gateway-client`, `openclaw-macos`,
  `openclaw-linux`, `openclaw-ios`, `openclaw-watchos`, `openclaw-android`,
  `node-host`, `openclaw-worker`, `test`, `fingerprint` or `openclaw-probe`.
  `client.mode` must be one of `webchat`, `cli`, `ui`, `backend`, `node`,
  `worker`, `probe` or `test` (`schema` `ConnectParams`;
  `@openclaw/gateway-protocol/dist/client-info.mjs`). The probe used
  `id: "gateway-client"`, `mode: "ui"` and a free-text `displayName` (live).
  The display name is what other surfaces show: device lists, and
  `resolvedBy` on approvals. Avoid the `openclaw-*` app ids. The gateway gives
  native app ids special treatment (`isNativeAppUiClient`).
- **`hello-ok`** carries `protocol`, `server{version, buildId, connId,...}`,
  `features{methods[], events[], capabilities[]}`, `snapshot{presence, health,
  stateVersion, sessionDefaults, ...}`, `auth{role, scopes, deviceToken?,
  issuedAtMs?}`, `policy{maxPayload, maxBufferedBytes, tickIntervalMs,
  attachments{maxBytes, maxImageBytes}}` and `pluginSurfaceUrls{canvas}`
  (`schema` `HelloOk`). Live values: 505 advertised methods (506 with the probe plugin), 65 events and 41 capability flags;
  `maxPayload` 26214400, `tickIntervalMs` 30000,
  `attachments.maxBytes` 19464192, `attachments.maxImageBytes` 6291456.
- **Pairing.** A first connect from loopback with the shared token was
  approved silently (`approvedVia: "silent"`) and returned
  `hello-ok.auth.deviceToken` (live). Remote, LAN and tailnet connects
  create a pending request instead. The connect fails with
  `details.code: "PAIRING_REQUIRED"` and a request id. The owner approves
  with `device.pair.approve {requestId}` (`operator.pairing`) or
  `openclaw devices approve <requestId>`. Waiting sockets receive
  `device.pair.resolved` (source: `<openclaw>/docs/gateway/protocol/auth.md`;
  the remote path was not exercised live). Related methods:
  `device.pair.list`, `device.pair.reject`, `device.pair.remove`,
  `device.pair.rename`, `device.token.rotate`, `device.token.revoke` (all
  `operator.pairing`). Events: `device.pair.requested`,
  `device.pair.resolved`, `device.pair.changed`.
- **Device token reuse.** Reconnecting with only the stored device token,
  and no shared token, succeeded with `auth.method: "device-token"` and the
  stored scopes (live). Persist `deviceToken` with `auth.scopes`, keyed by
  device id and role.
- **Scope upgrade.** Call `device.scopes.requestUpgrade {scopes}` on the
  live socket (`operator.read`). `scopes` must include the connection's
  current scopes; a strict superset is required. It returns `{requestId}`
  and creates a pending pairing request even on loopback. After approval
  through `device.pair.approve`, `device.scopes.waitUpgrade {requestId}`
  resolves to `{status:"approved", requestId, deviceToken, scopes}`, or to
  `rejected` or `expired` (`schema` `ScopeUpgradeRequest`, `ScopeUpgradeWait`,
  `ScopeUpgradeResult`). Live: the request and approval worked. Reconnecting
  afterwards with the old stored token failed with
  `AUTH_DEVICE_TOKEN_MISMATCH`, so approval rotates the token. The client
  must take the new token from `waitUpgrade` on the original socket and
  persist it before reconnecting. `GatewayScopeUpgrade` in
  `@openclaw/gateway-client/scope-upgrade` does this.
- **Client caps.** These are declared in `connect.params.caps`. Registry
  (`GATEWAY_CLIENT_CAPS`, `@openclaw/gateway-protocol/client-info`):
  `agent-kind`, `approvals`, `chat-only-assistant-text`, `exec-approvals`,
  `inline-widgets`, `model-catalog-snapshot`, `model-selection-policy`,
  `run-tool-bindings`, `session-scoped-events`, `plugin-approvals`,
  `task-suggestions`, `terminal-offset-seq`, `terminal-session-metadata`,
  `terminal-upload-path-style`, `tool-events`, `ui-commands`, `ultrafast`,
  `usage-refreshing`. Two of these are mandatory for Clawtrate:
  - Without `tool-events` the connection silently receives no tool
    lifecycle events (`<openclaw>/docs/gateway/clients.md`).
  - Without `approvals` and `exec-approvals`, the gateway did not count the
    connection as an approval route. An exec that needed approval was
    auto-denied with `reason: "no-route"` and the tool error "Headless runs
    cannot wait for interactive exec approval" (live). With the caps, the
    same command produced `exec.approval.requested` and could be resolved.
- **Status: available.**

### 2. List bots and read identity

- `agents.list {}` (`operator.read`) returns `{defaultId, ownership,
  selectionRequired, mainKey, scope, agents:[{id, name,
  identity{name, theme, emoji, avatar?}, workspace, model{primary},
  thinkingLevels, thinkingDefault, agentRuntime, ...}]}` (live).
- `agent.identity.get {agentId?|sessionKey?}` (`operator.read`) returns
  `AgentIdentityResult {agentId, name?, nameSource?, avatar?, avatarSource?,
  avatarStatus?: none|local|remote|data, emoji?}` (live: an emoji-only bot
  returned `avatar: "🧭"`). An avatar is a workspace-relative image path, an
  `http(s)` URL or a `data:` URI. Local files are limited to 2 MB
  (`<openclaw>/docs/gateway/config-agents/entries-and-multi-agent.md`).
- There is no description field in the RPC shapes. Config has
  `agents.entries.<id>.description` and `identity.theme`; `theme` is
  returned by `agents.list`. Whether `agents.list` returns `description` is
  **unverified**: the probe bots had none set.
- Changes arrive through `config.changed` (payload: path and hash only),
  followed by a refetch.
- **Status: available.** Description is config-only.

### 3. Create, edit and delete a bot

| Field | How | Scope |
| --- | --- | --- |
| name, emoji, avatar, workspace, model | `agents.create {name, workspace?, model?, emoji?, avatar?}` returns `{ok, agentId, name, workspace}`; `agents.update {agentId, name?, workspace?, model?: string\|null, agentRuntime?, emoji?, avatar?}` | `operator.admin` |
| delete | `agents.delete {agentId, deleteFiles?}` returns `{ok, agentId, removedBindings, removed[], failed[]}`; files go to trash | `operator.admin` |
| instructions / system prompt | workspace bootstrap files: `agents.files.list {agentId}`, `agents.files.get {agentId, name}`, `agents.files.set {agentId, name, content, expectedHash?, expectedMissing?}`. Allowed names: `AGENTS.md`, `SOUL.md`, `USER.md`, `BOOTSTRAP.md`, `MEMORY.md` (listed by `agents.files.list`) | read / `operator.admin` for set |
| reasoning effort default, tools, exec policy, bot-to-bot targets, description | `config.patch {raw, baseHash}` with a merge patch under `agents.entries.<id>` (`thinkingDefault`, `reasoningDefault`, `tools.{profile, allow, deny, alsoAllow, exec.mode, agentToAgent.send}`, `description`, `identity.*`). `baseHash` comes from `config.get().hash`; without it the patch is refused ("config base hash required") | `operator.admin` (all of `config.*` is admin) |

Live: `agents.create`, `agents.update`, `agents.delete`, `agents.files.set`
and `config.patch` all succeeded. A patch setting `tools.deny: ["exec"]` on
one bot removed `exec` from the next model request. A call then failed with
"Tool exec not found". The patch hot-reloaded without a restart. Caveat:
`tools.effective` still listed `exec` for that session afterwards, so do not
treat it as the enforcement source.

Caveats: every write needs `operator.admin`. One bot edit takes several calls
across two families, and there is no single atomic update. Config writes go
through compare-and-swap on `baseHash`.

**Status: partial.** Everything is possible, but only for an admin
connection and not atomically. See plugin P1.

### 4. Sessions (tasks) per bot

- Session keys are `agent:<agentId>:main` for the bot's main thread and
  `agent:<agentId>:dashboard:<uuid>` for sessions made with
  `sessions.create` (live). Always pass `agentId` or an agent-prefixed key.
  Multi-agent gateways reject an unscoped `main` ("Multiple agents are
  configured, but session key "main" has no explicit owner").
- `sessions.list` (`operator.read`, `SessionsListParams`, closed):
  `limit, offset, agentId? (via filters), activeOnly, ownerFirst,
  rowMode:"compact", includeDerivedTitles, includeLastMessage, archived,
  group, label, ...`. It returns `{count, totalCount, limitApplied,
  nextOffset, hasMore, defaults, sessions:[row]}` (live).
- `sessions.subscribe {…list params}` (`operator.read`) returns
  `{subscribed:true, list}`, then a stream of `sessions.changed` events
  carrying `{sessionKey, agentId, sessionId, reason, session:<row>, ...}`
  (live). Install the listener before the call. Events can arrive before
  the response.
- `sessions.messages.subscribe {key, agentId?, subscriptionId?, mode?,
  includeApprovals?}` (`operator.read`) gives per-session live events:
  `session.message` (one committed transcript row, with `messageId`,
  `messageSeq` and `message`), `chat`, `agent`, and `session.approval`
  when `includeApprovals` is set. Pair it with
  `sessions.messages.unsubscribe`. `mode: "narration"` swaps token deltas
  for `session.narration` snapshots, which suits a sidebar.
- History: `chat.history {sessionKey, agentId?, limit?, offset?, cursor?,
  messageId?, sessionId?, maxChars?, toolResultMaxChars?}`
  (`operator.read`) returns `{sessionKey, sessionId, messages[], nextOffset,
  hasMore, inFlightRun?, sessionInfo?}` (live).
  `chat.message.get {sessionKey, messageId}` fetches one row (live).
- **Stable ids.** Every row has `__openclaw.id`, the transcript entry
  identity, and `__openclaw.seq`. One stored record can project into several
  display rows, so key UI rows by `(id, index)`. Use `__openclaw.id` as a
  durable anchor, never numeric offsets (`<openclaw>/docs/gateway/clients.md`,
  "Use history metadata and stable anchors"). `session.message.messageId`
  equals `__openclaw.id` (live).
- Create, rename and archive: `sessions.create {agentId, label?, message?,
  model?, thinkingLevel?, permissionMode?, toolOverrides?, execNode?, cwd?,
  attachments?, ...}` (dynamic scope) returns `{ok, key, sessionId, entry,
  runStarted, runId?}` (live). For metadata use `sessions.patch` (dynamic)
  and `sessions.delete` (dynamic). `sessions.describe {key}` returns one
  full row (live).
- **Status: available.**

### 5. Send, attach, abort, queue, steer

- `chat.send` (`operator.write`, `ChatSendParams`, closed): required
  `sessionKey`, `message`, `idempotencyKey`. Optional `agentId`,
  `attachments[]`, `queueMode: steer|followup|collect|interrupt`,
  `thinking`, `fastMode`, `timeoutMs`, `mentions` and `replyToId`. Returns
  `{runId, status:"started", messageSeq?}` (live).
- Attachment item:
  `{type, mimeType, fileName, content (base64), sizeBytes?, width?, height?,
  origin?: paste|file}`, open object (`schema`). Live: a 1×1 PNG with
  `type: "image"` was accepted, and the model turn carried
  `source_modality: "image"`. Limits: the per-file ceilings in
  `hello-ok.policy.attachments`, plus the whole frame under
  `policy.maxPayload`. Base64 inflates by about a third, so a file near
  `maxBytes` overflows the frame on its own. There is no chunked upload for
  chat attachments.
- `sessions.send {key, message, agentId?, attachments?, thinking?,
  timeoutMs?, idempotencyKey?}` (`operator.write`) is the session-keyed
  equivalent.
- Abort: `chat.abort {sessionKey, agentId?, runId?, preserveSideRuns?,
  discardPendingInput?}` (`operator.write`) returns
  `{ok, aborted, runIds[]}` (live). `sessions.abort {key?, runId?,
  agentId?, clearQueued?}` (`operator.write`). Aborted runs end with
  `chat state:"aborted"` and `agent stream:"lifecycle" phase:"error"
  aborted:true` (live).
- Steer: `sessions.steer` (`operator.write`; its params are not in the
  published schema). Live: `{key, message}` returned
  `{runId, status:"started", interruptedActiveRun:true}`. Separately,
  `chat.send` with `queueMode: "steer"` during a streaming text reply
  aborted the active run. The steer run then failed with
  `chat state:"error"`, `errorMessage: "Session reader operation is no
  longer current"`. With a real model, steering is meant to inject at tool
  boundaries (`<openclaw>/docs/concepts/queue-steering.md`). With the
  scripted model it interrupted. **Builders should cover steer with an e2e
  test and not assume in-place injection.**
- **Status: available**, with the steer caveat.

### 6. Streaming

Two projections exist. Pick one per view; consuming both double-counts text.

- `chat` event (`schema` `ChatEvent`, union by `state`):
  - `status`: `{runId, sessionKey, agentId, seq, phase}`. Phases:
    `waiting_for_state`, `preparing_workspace`, `naming_worktree`,
    `creating_worktree`, `running_setup`, `provisioning_environment`,
    `preparing_context`, `memory_flushing`, `starting_model`. There is
    optional `retry{attempt, maxAttempts, reason:"rate_limit"}`.
  - `delta`: `{deltaText, message?, replace?, usage?}`. The first frame per
    recipient carries a full `message` snapshot. `replace: true` means
    `deltaText` replaces the text (live: an empty replace precedes the final).
  - `final`: `{message, usage?, stopReason?}`; `aborted`:
    `{message?, errorMessage?, stopReason?}`; `error`: `{errorMessage,
    errorKind?, errorDetail?}`.
- `agent` event (`schema` `AgentEvent`: `{runId, seq, stream, ts, data,
  spawnedBy?, isHeartbeat?}` plus `sessionKey`, `agentId` and `sessionId`
  on the wire; `data` is untyped in the schema). Streams observed live:
  - `lifecycle`, with `data.phase` one of `start`, `model{provider, model}`,
    `waiting-approval`, `approval-resolved`, `finishing`, `end{stopReason,
    aborted, startedAt, endedAt, terminalReply{disposition, text},
    terminalReceipt}`, `error{error}`.
  - `run_status`: `{phase}`, mirroring the chat status phases.
  - `thinking`: `{text, delta}`. This is the reasoning stream. It is
    cumulative `text` plus the appended `delta`.
  - `assistant`: `{text, delta, itemId}`.
  - `usage`: `{outputTokens}`.
  - `tool`, `item` and `command_output`: see row 7.
  - Also emitted in source, not seen live: `plan`, `approval`,
    `compaction`, `patch`, `execution`, `error`, `stdout`, `stderr`, `acp`
    (`stream: "<name>"` literals across `<openclaw>/dist/*.mjs`).
- Ordering: `payload.seq` is per run, and the outer frame `seq` is per
  connection. On a forward gap, reload history
  (`<openclaw>/docs/gateway/clients.md`).
- Reasoning shows up only when the model reports reasoning and visibility is
  on. The probe model had `reasoning: true`; per session use
  `sessions.patch {reasoningLevel}`, per bot `reasoningDefault` (on, off or
  stream).
- **Status: available.**

### 7. Tool events and bot-to-bot cards

You need `caps: ["tool-events"]` (row 1). For each tool call the connection
receives (live, every tool tried):

```text
agent stream:"item"  data:{itemId:"tool:<toolCallId>", toolCallId, name, kind:"tool",
                           phase:"start", title, status:"running", meta?, commandBearing, startedAt}
agent stream:"tool"  data:{phase:"start", name, toolCallId, args}
agent stream:"tool"  data:{phase:"update", name, toolCallId, partialResult:{content[], details}}   (long-running tools)
agent stream:"item"  data:{..., phase:"update", status:"running"}
agent stream:"command_output" data:{itemId:"command:<toolCallId>", phase:"delta"|"end", output, exitCode?, cwd?}  (exec only)
agent stream:"tool"  data:{phase:"result", name, toolCallId, meta?, isError, result:{content[], details}}
agent stream:"item"  data:{..., phase:"end", status:"completed", endedAt}
```

The `tool` frames on the wire also carry a `session` row snapshot, which can
be large. The transcript keeps the call as an assistant content block
`{type:"toolCall", id, name, arguments}` and the result as a
`{role:"toolResult", toolCallId, toolName, content, details, isError}` row
(live, `chat.history`). That lets a card be rebuilt from history after a
reconnect.

**Bot-to-bot messaging** uses the `sessions_send` tool (source: schema
`SessionsSendToolSchema` and output union `SessionsSendOutputSchema` in
`<openclaw>/dist/sessions-spawn-tool-CMHR26Kp.mjs`). Arguments:
`{sessionKey?, label?, agentId?, message, timeoutSeconds?, watch?, mode?:
notify|steer|followup|resume}`. Results include:

- `{runId, status:"ok", sessionKey, delivery:{status}, reply}`, the waited
  reply;
- `{runId, status:"accepted", sessionKey, targetDisposition:"queued"|"steered", delivery}`;
- `{runId, status:"timeout", error, sentBeforeError:true, sessionKey}`;
- `{runId, status:"no_reply", sessionKey, message}`;
- `{status:"queued", sessionKey, notificationId, durability:"process", runStarted:false}`;
- `{runId, status:"error"|"forbidden", error}`.

Live run (bot Pixel to bot Atlas):

- `tool start`: `{name:"sessions_send", args:{sessionKey:"agent:atlas:main",
  message:"Please list three colours.", timeoutSeconds:60}}`.
- The target run streamed on the same connection with its own
  `runId` and `sessionKey: "agent:atlas:main"`. That `runId` equals the
  result's `details.runId`.
- `tool result`: `result.details = {runId, sessionKey:"agent:atlas:main",
  status:"ok", delivery:{status:"skipped"}, reply:"Echo: Please list three colours."}`.
- The target transcript records the incoming turn as a user message
  wrapped in an inter-session envelope (`[Inter-session message]
  sourceSession=agent:pixel:main ... sourceTool=sessions_send`).

To render a "Messaged <bot>" card, match `data.name === "sessions_send"`.
Take the target from `args.sessionKey` (the `agent:<id>:` prefix), or from
`args.agentId`/`args.label`. The sent text is `args.message`, and the reply
is `result.details.reply`. To expand into the full exchange, open
`result.details.runId` in the target session. Use the events already
received for that `runId`, or reload the target's `chat.history`;
`ChatHistoryParams.inputRunIds` exists in the schema, but filtering by it is
**unverified**. Related
tools with the same tool event shape: `sessions_spawn` (sub-agent),
`agents_wait`, `subagents`, `conversations_send` and `conversations_turn`
(external channel addresses). Allowed targets are controlled per bot by
`agents.entries.<id>.tools.agentToAgent.send` (live: Pixel was allowed
`["atlas"]`).

**Status: available.**

### 8. Approvals

- Listing: `exec.approval.list {}` returns `[{id, request{command, cwd, host,
  nodeId, security, ask, agentId, sessionKey, runId, toolCallId,
  allowedDecisions[], commandAnalysis, resolvedPath}, createdAtMs,
  expiresAtMs, approvalKind:"exec"}]` (live). Also
  `exec.approval.get {id}`, `plugin.approval.list`, `approval.get` and
  `approval.history {}` (live: it returned the resolved exec approval with
  `presentation`, `decision` and `reason`). All use `operator.approvals`.
- Live events: `exec.approval.requested` (payload as one list item),
  `exec.approval.resolved {id, decision, resolvedBy, ts, request}`, and
  `plugin.approval.requested`/`resolved` (live for exec). With
  `includeApprovals` on the session subscription, a sanitized
  `session.approval {sessionKey, phase:"pending"|"terminal",
  approval{id, status, presentation{kind, commandText, host, agentId,
  allowedDecisions}, urlPath, createdAtMs, expiresAtMs, decision?, reason?}}`
  (live) also arrives. The run shows `agent lifecycle phase:"waiting-approval"`
  and then `"approval-resolved"`.
- Resolving: `exec.approval.resolve {id, decision}`, where decision is
  `allow-once`, `allow-always` or `deny`, returns `{ok:true}` (live).
  `plugin.approval.resolve {id, decision}`. Generic
  `approval.resolve {id, kind:"exec"|"plugin"|"system-agent", decision,
  grantExpiresInDays?}`. Standing grants: `exec.approval.grants.list`,
  `exec.approval.grants.revoke`.
- The connection must advertise `approvals` and `exec-approvals` caps, and
  `plugin-approvals` for plugin approvals. Otherwise approvals are
  auto-denied as `no-route` (row 1). Call `exec.approval.list` after
  `hello-ok` to backfill.
- Per-bot policy: `agents.entries.<id>.tools.exec.mode` is one of `deny`,
  `allowlist`, `ask`, `auto` or `full`, set via `config.patch` (admin).
  Live: `mode: "ask"` on one bot turned an unlisted command into an
  approval. The host approvals document is
  `exec.approvals.get` / `exec.approvals.set {file, baseHash}`
  (`operator.admin`). It has `defaults` and a per-agent `agents` map (live
  `get`). Per-session settings go through `sessions.patch {execSecurity,
  execAsk, permissionMode}`.
- **Important default:** with no exec policy configured, the probe gateway
  resolved `security: "full", ask: "off"`. The scripted model's `exec`
  ran `uname -s` with no approval (live). A development gateway must set
  an exec mode explicitly (section 4 does).
- Approval rules for tools other than exec, for example "ask before Pixel
  messages another bot" or "ask before browser navigation", have no config
  surface. A plugin `before_tool_call` hook can return `requireApproval`
  (source: `<openclaw>/docs/plugins/hooks/tool-policy.md`). See plugin P5.
- **Status: available** for exec and plugin approvals; **partial** for
  per-bot rules on other tools.

### 9. Schedules

- `cron.list {agentId?, includeDisabled?, ...}`, `cron.get`, `cron.status`,
  `cron.runs {id, limit?, offset?, statuses?}` and
  `cron.history {id, runId|runAtMs}` are `operator.read`. `cron.add`,
  `cron.update {id, patch}`, `cron.remove {id}` and
  `cron.run {id, mode?: due|force|if-enabled, waitTimeoutMs?}` are
  `operator.admin`. The event is `cron`.
- `CronAddParams` (closed): `{name, agentId?, schedule, sessionTarget:
  "main"|"isolated"|"current"|<key>, wakeMode:"next-heartbeat"|"now",
  payload, delivery?, enabled?, description?, ...}`.
  - `schedule` is one of `{kind:"at", at}`, `{kind:"every", everyMs}`,
    `{kind:"cron", expr, tz?}`, `{kind:"on-exit", command}` or
    `{kind:"stream", command[]}`.
  - `payload` is one of `{kind:"agentTurn", message, model?, thinking?,
    toolsAllow?}`, `{kind:"systemEvent", text}` or `{kind:"command", argv}`.
- Live: add, list, run with `mode:"force"` (it returned the finished run
  inline: `{ok, enqueued, runId:"manual:<jobId>:<ms>:1",
  run{status:"ok", summary}}`), runs, update and remove all worked.
  `cron.history` requires `runId` or `runAtMs`.
- **Status: available.** Mutations are admin-only.

### 10. Memory

- Search and inspect: `memory.status {agentId}`,
  `memory.search {agentId, query}` and `memory.get` (`operator.read`;
  their params are not in the published schema). Live: `status` returned
  the backend and index state. `search` returned
  `{provider:"none", searchMode:"fts-only", results:[]}` even after a
  matching `MEMORY.md` was written, because the index had not been built.
  The gateway asked for `openclaw memory status --index --agent <id>`.
  `memory.get` requires "a provider-scoped memory reference" taken from
  search results; untested for that reason.
- Edit: memory is Markdown in the bot workspace. `MEMORY.md` is read and
  written through `agents.files.get`/`agents.files.set` (admin for set;
  live). Dated notes under `memory/` are refused by
  `agents.files.set` ("unsupported file"). They can be read through
  `agents.workspace.list {agentId, path?}` and
  `agents.workspace.get {agentId, path}` (live for `MEMORY.md`). Bulk
  repair tools exist under `doctor.memory.*` (admin) and
  `migrations.memory.*`.
- Delete: there is no RPC to delete one memory item or file.
- **Status: partial.** Read works. Editing covers only `MEMORY.md`, needs
  admin, and does not update the index. See plugin P2.

### 11. Files and artifacts

- Workspace browsing: `agents.workspace.list {agentId, path?, offset?,
  limit?}` returns `{entries:[{path, name, kind, size, updatedAtMs}],
  totalEntries}`. `agents.workspace.get {agentId, path}` returns
  `{file{path, size, mimeType, encoding, content}}`. Both are
  `operator.read` (live).
- Session-scoped files: `sessions.files.list {sessionKey, path?, search?}`
  returns `{root, gitCheckout, files[], browser{entries}}` (live).
  `sessions.files.get {sessionKey, path}` (read). `sessions.files.set` and
  `sessions.files.reveal` (admin). `sessions.files.assets` (read).
  `sessions.diff` (read).
- Artifacts: `artifacts.list {sessionKey, runId?, type?:"image", limit?,
  cursor?}` (live: empty), `artifacts.get {artifactId, ...}`, and
  `artifacts.download {artifactId, sessionKey, transport?:"http"}`.
  Without `transport`, base64 data comes back over the socket. With
  `transport:"http"`, you get a five-minute, connection-bound URL under
  `/api/artifacts/download/`; add `?variant=thumbnail` for a PNG preview of
  at most 1200 px (`<openclaw>/docs/gateway/clients.md`). Images in the
  transcript are `{type:"image", artifactId, url, mimeType, ...}` blocks.
  `assistant.media.get` is also callable.
- **Status: available.** Only download over HTTP was not exercised live.

### 12. Models and effort

- `models.list {agentId?, sessionKey?, view?: default|configured|provider-config|all, includeDetails?}`
  (`operator.read`) returns `{models:[{id, name, provider, contextWindow,
  reasoning, thinkingLevels[{id,label}], thinkingDefault, available}]}`
  (live). `chat.metadata {agentId?, sessionKey?, includeModels?}` returns
  the models plus the slash-command list (live). Events: `models.snapshot`
  and `chat.metadata.changed`.
- Per session: `sessions.patch {key, model, thinkingLevel, fastMode,
  reasoningLevel, contextWindow}` (dynamic scope; live with
  `model:"fake/scripted", thinkingLevel:"high"`). Model refs are
  `provider/modelId`. The thinking levels a model offers come from its
  entry (live: off, minimal, low, medium, high, ultra).
- Per bot: `agents.update {model}` (admin), plus `thinkingDefault`,
  `reasoningDefault` and `fastModeDefault` through `config.patch` (admin,
  live for `thinkingDefault`). `chat.send {thinking}` is a per-message
  override.
- **Status: available.**

### 13. Nodes and machine choice

- `node.list {}` and `node.describe {nodeId}` (`operator.read`; live: an
  empty list, since no node was paired). Pairing: `node.pair.list`,
  `node.pair.approve`, `node.pair.reject`, `node.pair.remove` and
  `node.rename` (`operator.pairing`). Approving a node that declares
  `system.run` or `browser.proxy` also needs `operator.admin`. Invoke with
  `node.invoke {nodeId, command, params?, idempotencyKey}` (dynamic scope).
  Events: `node.pair.requested`, `node.pair.resolved`, `node.presence`,
  `node.hostStats`, `node.runnerInventory.changed` and
  `node.invoke.request`.
- Choosing where a bot's tools run:
  - per session, `sessions.patch {execHost, execNode}` and
    `sessions.create {execNode}` (`schema`);
  - per bot, `agents.entries.<id>.tools.exec.{host, node}` in config;
  - per browser call, `browser.request {target:"node", node:"<id>"}`.
- **Status: available** by schema and docs. **Not exercised live**,
  because the probe had no paired node. Builders should add a
  headless-node fixture (`openclaw --profile <dev> node run`) before
  depending on this.

### 14. Tool permissions and exec policy per bot

- Reading: `tools.catalog {agentId?, includePlugins?}` returns profiles
  (minimal, coding, messaging, full) and tool groups with
  `defaultProfiles`. `tools.effective {sessionKey}` returns the session's
  groups and tools (both `operator.read`, live).
- Writing per bot: `config.patch` under
  `agents.entries.<id>.tools.{profile, allow, alsoAllow, deny, exec.mode,
  exec.ask, exec.security, exec.host, exec.node, agentToAgent.send, fs,
  elevated}` (admin; live for `deny` and `exec.mode`).
- Per session: `sessions.patch {toolOverrides, permissionMode:
  read-only|guarded|workspace|full, execSecurity, execAsk}`, and
  `sessions.create {permissionMode, toolOverrides}` (live with
  `permissionMode:"guarded"`).
- Host approvals: `exec.approvals.get`/`set` (admin).
- **Status: available** for admin connections.

### 15. Usage, cost and context

- `usage.status {}` (`operator.read`) returns provider quota windows (live:
  `{providers:[]}` with the fake provider). Advertise `usage-refreshing` to
  get a fast cold response.
- `usage.cost {agentId}` (`operator.read`) returns
  `{days, daily:[{date, input, output, cacheRead, cacheWrite, totalTokens,
  totalCost, ...}]}`. `agentId` is required on multi-agent gateways (live).
- `sessions.usage {key?, agentId?, range?, startDate?, endDate?}`,
  `sessions.usage.timeseries` and `sessions.usage.logs` give per-session
  token and cost history (live for `sessions.usage`).
- Context window: rows from `sessions.describe`, `chat.history.sessionInfo`
  and `sessions.changed` carry `contextTokens`, `inputTokens`,
  `outputTokens`, `totalTokens` and `contextBudgetStatus{contextTokenBudget,
  estimatedPromptTokens, remainingPromptBudgetTokens, reserveTokens,
  shouldCompact, route}` (live). The live `agent` stream also has `usage`
  frames.
- Do not poll usage for live lists. Rows on `sessions.changed` carry it
  (`<openclaw>/docs/gateway/clients.md`).
- **Status: available.**

### 16. Notifications and mobile push

- Web Push for browsers and PWAs: `push.web.vapidPublicKey` (live: it
  returned a key), `push.web.subscribe`, `push.web.unsubscribe`,
  `push.web.test` and `push.web.preferences.get {endpoint}` / `set`
  (`operator.write` or read). Payloads are generic, and a tap opens the
  gateway's `/approve/<id>` page (`<openclaw>/docs/web/notifications.md`).
- iOS: only the official OpenClaw iOS app gets APNs. It registers with a
  hosted relay using App Attest and a StoreKit receipt, then sends the relay
  handle to the gateway as a **node-role** `node.event` with
  `event: "push.apns.register"` (source:
  `<openclaw>/dist/server-node-events-D7AhsYlE.mjs`;
  `<openclaw>/docs/platforms/ios.md`). `push.test` sends to such a node. The
  only knob is `gateway.push.apns.relay.baseUrl` for a custom relay that
  matches a custom build. A third-party app cannot pass the hosted relay's
  attestation.
- Expo push tokens have no RPC.
- **Status: missing** for a Clawtrate iOS app. See plugin P3. Desktop can
  use OS notifications driven by the events it already receives.

### 17. Voice and talk (brief)

- Scope is `operator.talk`; `operator.write` also satisfies it. Methods:
  `talk.catalog` and `talk.config` (read, or `operator.talk.secrets` for
  keys), `talk.mode {enabled, phase?}`, `talk.speak`, gateway-relayed
  realtime audio through `talk.session.create`, `appendAudio`,
  `cancelOutput`, `submitToolResult`, `steer` and `close`, client-owned
  realtime through `talk.client.create`, `transcript`, `toolCall`, `steer`
  and `close`, `talk.voice.get/set/complete`, and `tts.*`. Events:
  `talk.event`, `talk.mode` and `talk.voice.change`.
- Multi-agent gateways need `talk.agentId` in config. Without it,
  `talk.catalog` failed with `AGENT_SELECTION_REQUIRED` (live).
- **Status: available** by schema. Not exercised beyond that error.

### 18. The bot's computer

**Dedicated browser: live view and input are built in.** The bundled
`browser` plugin registers:

- `browser.request` with scope **`operator.admin`**
  (`BROWSER_REQUEST_GATEWAY_SCOPE` in
  `<openclaw>/dist/browser-gateway-contract-WuzRejvY.mjs`; registered in
  `<openclaw>/dist/plugin-registration-6Nzv0VmS.mjs`). It proxies the
  browser control routes: `{method, path, query?, body?, target?, node?}`.
- `browser.dashboard.request` with scope `operator.write`, session access
  and `requiredTool: "browser"` (same file). It drives a `browser:dashboard`
  widget for non-admin users.
- An upgrade route, `/browser/screencast`.

Route list: `<openclaw>/dist/routes-DV0YryHA.mjs`;
`<openclaw>/docs/tools/browser-control.md`.

Live sequence, using a headless managed Chromium:

1. `browser.request {method:"POST", path:"/start"}` returns
   `{ok, profile:"openclaw"}`. `GET /` reports `cdpPort` and `transport:"cdp"`.
2. `POST /tabs/open {url}` returns `{targetId, suggestedTargetId:"t1", title,
   url}`. `GET /tabs` lists tabs.
3. `POST /screencast {targetId?, maxWidth?, maxHeight?, quality?}` returns
   `{token, wsPath:"/browser/screencast?token=<48 hex>", expiresAtMs,
   targetId, url}`. The token is single use, lives 60 s and is bound to the
   requesting gateway connection.
4. Open a WebSocket to the gateway origin plus `wsPath`. Text frames are
   JSON, `{type:"ready", targetId, url, title}`, `meta` or `error`. Binary
   frames are a 4-byte big-endian header length, then a JSON header
   `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`, then JPEG bytes.
   Live: 21 frames in about 5 s at 756×469, the first written out as a
   valid JPEG. Close codes: 4001 token, 4003 `navigation_blocked`, 4004
   `target_closed`, 4005 unsupported, 4006 `authority_revoked`, 1012
   shutdown.
5. Input goes through `POST /act {kind, ...}`. Kinds are `batch`, `click`,
   `clickCoords {x, y, button?, doubleClick?}`, `type`, `press {key}`,
   `hover`, `scrollIntoView`, `drag`, `select`, `fill`, `resize`, `wait`,
   `evaluate` and `close`; `insertText` is used for paste (live: `press`
   worked; `clickCoords` checked in source,
   `<openclaw>/dist/extensions/browser/runtime-api.d.ts`). There is no
   wheel kind. The Control UI scrolls with `evaluate`, which needs
   `browser.evaluateEnabled`, on by default. Also available:
   `GET /snapshot` (aria tree, live), `POST /screenshot`, `POST /navigate`,
   tab focus and close.

Caveats:

- `operator.admin` is required for the free-form browser. A non-admin
  connection can only use `browser.dashboard.request` against a
  `browser:dashboard` widget in its own session.
- There is **no takeover arbitration** for the gateway browser. Agent and
  user input interleave. The takeover pause the docs describe exists only
  for cloud-worker desktops (`<openclaw>/docs/nodes/computer-use.md`).
- Headful launch is the default. Development gateways should set
  `browser.headless: true`.
- Screencast is unsupported for Chrome MCP existing-session profiles and for
  node-routed browsers (HTTP 501 or `SCREENCAST_UNSUPPORTED`). The Control
  UI falls back to `POST /screenshot` polling.

**Canvas.** `hello-ok.pluginSurfaceUrls.canvas` is a scoped hosted URL
(live: present). Renew it with `plugin.surface.refresh`
(`operator.read`). Agents' canvas documents are fetched with
`canvas.document.view {docId}` and `canvas.document.preview`
(`operator.read`; live: an unknown id returned `UNAVAILABLE`). A client can
embed the hosted canvas URL in a web view.

**Node and desktop screens.**

- `computer.status {probe?}` (`operator.read`; live:
  `{configured:false, available:false}`).
- `computer.invoke {command:"screen.snapshot"|"computer.act", params,
  generation, idempotencyKey}` (`operator.write`) drives the gateway's or a
  node's computer-use provider. A paired node also exposes
  `screen.snapshot` and `screen.record` through `node.invoke`. These are
  still images and recordings, not a stream.
- Cloud-worker desktops have `desktop.observe` and `desktop.launch`
  (admin), with the takeover semantics above. **Unverified live.**

**Verdict:** a near-live view of the bot's browser, about 20 fps JPEG over a
gateway WebSocket, works today, and so does user input. Both require
`operator.admin`. What is missing is a "user has control" lock that stops
the bot from acting while the user drives, plus a stream for non-admin
viewers. **Status: partial.** See plugin P4.

## 3. Plugin API

### Structure and install

A plugin is a folder or package with an `openclaw.plugin.json` manifest
(`id`, `name`, `description`, `categories`, `activation.onStartup`,
`configSchema`, and `contracts.tools` when it adds agent tools) and an ESM
entry listed under `package.json` `openclaw.extensions`. The entry exports
`{ id, name, description, register(api) }`. `definePluginEntry` from
`openclaw/plugin-sdk/plugin-entry` is the typed form
(`<openclaw>/docs/plugins/building-plugins.md`,
`<openclaw>/docs/plugins/manifest.md`). A working minimal plugin is
committed at `docs/research/dev-gateway/probe-plugin/`. It needs no
dependencies.

Registrars used or checked (types in
`<openclaw>/dist/config-contracts-C65kIjn4.d.ts`, `OpenClawPluginApi`):

- `api.registerGatewayMethod(name, handler, { scope?, profileAccess?,
  sessionAccess?, shareKey? })`. The handler receives
  `{ params, respond(ok, payload?, error?), client, context, req, ... }`.
  Core prefixes `config.*`, `exec.approvals.*`, `wizard.*` and `update.*`
  are forced to `operator.admin`. `sessionAccess: { mode, requiredTool,
  allowOwnSessionScope }` admits callers per session.
- `api.registerHttpRoute({ path, auth: "gateway"|"plugin", match?:
  "exact"|"prefix", handler(req, res), handleUpgrade? })` serves HTTP and
  WebSocket upgrades on the gateway port.
- `api.registerService({ id, start(ctx), stop() })`. `ctx.gatewayEvents.emit(name,
  payload, { scope })` broadcasts an event named `plugin.<pluginId>.<name>`.
  The name is one lowercase segment, the payload is bounded JSON, and the
  scope is read, write or admin (`<openclaw>/docs/plugins/sdk-entrypoints/registration-mode.md`;
  `<openclaw>/dist/services-CDza9GQm.mjs`).
  `ctx.gatewayEvents.onSessionsChanged(fn)` observes session changes.
  `context.broadcast(event, payload, opts)` is also available in method
  handlers.
- `api.registerTool(...)`, `api.on("before_tool_call", handler)` (block,
  rewrite params, or `requireApproval`), and other hooks
  (`<openclaw>/docs/plugins/hooks/tool-policy.md`).
- `api.runtime.gateway.request(method, params)` makes in-process calls to
  other gateway methods (`<openclaw>/docs/plugins/sdk-runtime/gateway-and-nodes.md`).

Verified live against the probe gateway, with the plugin installed into
that profile only:

```bash
openclaw --profile <dev> plugins install --link <checkout>/docs/research/dev-gateway/probe-plugin --force
# "Applied in Gateway generation N": hot-installed, no restart
```

- `clawtrate-probe.ping {note}` returned `{pong:true, at, emitted:true}`.
- The connection received event `plugin.clawtrate-probe.pinged` with payload
  `{at, note}`.
- `GET /clawtrate-probe/health` returned 401 without auth and
  `200 {"ok":true}` with `Authorization: Bearer <gateway token>`.

Install scope: `--profile <name>` keeps the install inside that profile. It
added `plugins.load.paths` and `plugins.entries.<id>.enabled` to that
profile's config only. Linked installs are for development; packaged
installs use `npm-pack:` or ClawHub specs. All plugin APIs are marked
experimental, so pin the host version.

### Plugins for partial and missing rows

**P1, `clawtrate-bots` (row 3, partial).** One atomic, typed bot editor.

- Methods (all `operator.admin`, the same trust as today, but one call):
  `clawtrate-bots.get {agentId}` returns identity, description,
  instructions (`SOUL.md`, `AGENTS.md`), model, `thinkingDefault`, tool
  policy, exec mode and agent-to-agent targets.
  `clawtrate-bots.update {agentId, expectedRevision, patch}` validates a
  closed field set, writes config through the runtime config API, and
  writes bootstrap files.
- Event: `plugin.clawtrate-bots.changed {agentId, revision}`.
- Optional: a narrower `operator.write` method for name, avatar and
  description only, if the owner wants non-admin devices to rename bots.

**P2, `clawtrate-memory` (row 10, partial).**

- `clawtrate-memory.list {agentId}` lists `MEMORY.md` and `memory/**/*.md`
  with hashes. `clawtrate-memory.read {agentId, path}`.
  `clawtrate-memory.write {agentId, path, content, expectedHash}` and
  `clawtrate-memory.delete {agentId, path, expectedHash}`. Paths are
  confined to those globs inside the bot workspace. Scope is
  `operator.write`, or admin if the owner prefers.
- After each write it triggers the memory reindex for that agent through
  `api.runtime` and emits `plugin.clawtrate-memory.changed {agentId, path}`.
- Item-level editing, one bullet at a time, can be done client-side on top
  of whole-file writes.

**P3, `clawtrate-push` (row 16, missing).**

- `clawtrate-push.register {deviceId, expoPushToken, platform}`, `unregister`
  and `preferences.set` (`operator.write`; the token is stored in the
  plugin's state, keyed to the paired device).
- A service listens in-process for approval requests, questions, run
  completion and cron failures. It forwards a generic notification (no
  command text) to Expo's push service with a deep-link id, rechecking that
  the device is still paired and scoped before each send.
- Sending to Expo is an outbound call from the gateway host. Make it
  opt-in and documented.

**P4, `clawtrate-computer` (row 18, partial).** The live view, user
takeover, and non-admin viewing.

- `clawtrate-computer.view.open {sessionKey, agentId?, targetId?, maxWidth?,
  quality?}`. Scope `operator.write` with
  `sessionAccess: { mode: "write", requiredTool: "browser" }`, so a viewer
  must be allowed in that session, and admin is not required. Returns
  `{ticket, wsPath:"/clawtrate-computer/stream?ticket=…", expiresAtMs}`.
  Tickets are single use, short-lived and bound to the caller's connection.
  Revoke them when that connection closes, mirroring the built-in
  screencast.
- Streaming:
  - Preferred: reuse the built-in one. The handler calls
    `api.runtime.gateway.request("browser.request", {method:"POST",
    path:"/screencast", ...})` in-process and returns the result, so frames
    keep the built-in format, pacing, navigation policy and close codes.
  - Fallback, if in-process calls cannot carry admin authority for a
    non-admin caller: the plugin opens CDP itself. Read the profile's
    `cdpUrl` from `GET /`, attach to the tab's target, call
    `Page.startScreencast {format:"jpeg", quality, maxWidth, maxHeight,
    everyNthFrame:1}`, answer each `Page.screencastFrame` with
    `Page.screencastFrameAck`, and forward frames over a
    `registerHttpRoute({ handleUpgrade })` WebSocket in the same
    header-plus-JPEG framing. On `Page.frameNavigated`, stop and restart
    after the URL passes the browser plugin's navigation policy.
- Takeover:
  - `clawtrate-computer.control.take {sessionKey}` and `control.release`
    hold a per-session lease.
  - While the lease is held, a `before_tool_call` hook blocks the `browser`
    and `computer` tools for that session with
    `blockReason: "The user has control of the browser"`. The bot gets a
    clean tool error instead of fighting the user.
  - User input goes through `clawtrate-computer.input {sessionKey,
    kind:"clickCoords"|"type"|"press"|"scroll", ...}`. The plugin maps it
    to `/act`, and maps `scroll` to `evaluate` with `window.scrollBy`, using
    the lease as the authority.
  - Emits `plugin.clawtrate-computer.control {sessionKey, holder:
    "user"|"bot"}`. Release on disconnect, after an idle timeout, or when
    the user says so in chat.
- Cost: one CDP screencast per tab (the built-in plugin already shares one
  per profile and tab). No new browser processes.

**P5, `clawtrate-tool-rules` (row 8, partial for non-exec tools).**

- A `before_tool_call` hook reads a per-bot rule table from plugin config:
  `{agentId, tool, match?, action: "allow"|"ask"|"deny"}`. It returns
  `requireApproval` (which surfaces as `plugin.approval.requested` and is
  resolved with `plugin.approval.resolve`) or `block`.
- Methods `clawtrate-tool-rules.get` and `set` (admin).
- This gives "ask before messaging another bot" or "never navigate outside
  these hosts" per bot.

No plugin is proposed for rows 13 and 17: the surface exists but was not
exercised. For steer (row 5), a test is needed first, not a plugin.

## 4. Development gateway recipe

Everything here was run against an isolated profile and port, and is
committed under `docs/research/dev-gateway/`:

| File | Purpose |
| --- | --- |
| `fake-openai.mjs` | Scripted fake model provider: OpenAI Chat Completions streaming on loopback, no dependencies. |
| `openclaw.dev.json` | Gateway config: port, token from env, fake provider, two bots, exec policy, headless browser, mDNS off, fake MCP server. |
| `seed.mjs` | Creates bots, writes their instructions, and creates tasks with scripted transcripts. |
| `fake-coding-mcp.mjs` | Stand-in coding-agent MCP server (section 5). |
| `probe-plugin/` | Minimal plugin proving methods, events and routes (section 3). |

Profile and port: the project uses `--dev` (state in `~/.openclaw-dev`, port
19001). The commands below use a named profile, `<dev>`, so they run
anywhere. Replace `--profile <dev>` with `--dev` and the port with 19001 in
`tools/dev-gateway`.

```bash
CHECKOUT=$(pwd)
export OPENCLAW_DEV_TOKEN=$(openssl rand -hex 16)   # dev-only shared token; never a real credential

# 1. Fake model provider (keep running)
node docs/research/dev-gateway/fake-openai.mjs --port 19102 &

# 2. Fresh profile from the template
mkdir -p ~/.openclaw-<dev>
sed "s#<CHECKOUT>#$CHECKOUT#" docs/research/dev-gateway/openclaw.dev.json > ~/.openclaw-<dev>/openclaw.json
openclaw --profile <dev> config validate

# 3. Gateway in the foreground of its own shell, or backgrounded with its PID recorded
openclaw --profile <dev> gateway run &      # reads port 19101 and ${OPENCLAW_DEV_TOKEN} from config
echo $! > /tmp/dev-gateway.pid

# 4. Seed bots and tasks (needs @openclaw/gateway-client@2026.10.6 installed)
OPENCLAW_DEV_URL=ws://127.0.0.1:19101 node docs/research/dev-gateway/seed.mjs

# 5. Optional: the probe plugin
openclaw --profile <dev> plugins install --link "$CHECKOUT/docs/research/dev-gateway/probe-plugin" --force
```

Facts the recipe depends on, all verified live:

- **Custom provider base URL: yes.** `models.providers.<id>.baseUrl` with
  `api: "openai-completions"` (or `openai-responses`) points at any
  OpenAI-compatible server. `models.mode: "replace"` drops every built-in
  provider, so nothing can reach a real model. A non-secret `apiKey` such
  as `"fake-local"` is accepted for loopback URLs
  (`<openclaw>/docs/gateway/local-models.md`).
- The fake streams `delta.reasoning_content` for thinking. The adapter
  also accepts `reasoning` and `reasoning_text`
  (`<openclaw>/node_modules/@openclaw/ai/dist/openai-completions-transport-BRjxCG1C.mjs`).
  It streams `delta.content` for text, and `delta.tool_calls[{index, id,
  function{name, arguments}}]` with `finish_reason: "tool_calls"` for tools.
  Scripted directives in the user's message:
  - `#tool <name> <json>`: one tool call;
  - `#ask <sessionKey> <message>`: a `sessions_send` bot-to-bot call;
  - `#slow <seconds> <text>`: slow streaming, for abort and steer tests;
  - anything else: reasoning, then `Echo: <text>`.

  After a tool result it replies `Tool <name> returned: <result>`.
- `tools.toolSearch: false` is required. Custom providers otherwise get
  structured Tool Search, which hides real tools behind `tool_search`,
  `tool_describe` and `tool_call`, so `sessions_send` would arrive as a
  `tool_call` wrapper.
- `agents.ownership: "explicit"` is required once there are two or more
  bots. Validation fails without it.
- `discovery.mdns.mode: "off"` stops the dev gateway from advertising
  itself on the LAN over Bonjour, which it otherwise does.
- `browser.headless: true` avoids opening windows on the host.
- Exec policy must be explicit. Without it, exec runs with
  `security=full, ask=off`.
- The gateway also makes utility model calls, for activity recaps and
  titles, with no tools and a JSON body. The fake answers those with a
  fixed sentence, so recaps do not grow by echoing themselves.
- Seeding uses the loopback-only trusted backend identity:
  `client.id: "gateway-client"`, `mode: "backend"`, shared token, no
  device. That avoids pairing in scripts. Clawtrate itself must use a
  device identity.
- Transcripts: `sessions.create {agentId, label, message}` starts a scripted
  run. `chat.inject {sessionKey, message, label?}` (admin) appends an
  assistant row without a model call (live:
  `model:"gateway-injected"`).
- Reset: stop the gateway, delete `~/.openclaw-<dev>`, and repeat steps 2
  to 4. Live, the whole sequence produced three bots and four tasks,
  including a bot-to-bot exchange and an MCP call.
- Stopping: SIGTERM by PID. The probe gateway once took more than two
  minutes to exit after SIGTERM: its listener closed at once, but plugin
  service disposal ran past its budget. `tools/dev-gateway` should wait for
  the port to close, then SIGKILL that PID after a timeout.
- Credentials: none are copied or needed. The gateway creates its own
  `credentials/` and state directories inside the profile. The memory
  backend defaults to an embeddings provider that has no key here, so
  memory search falls back to full-text only.

## 5. Messaging T3 Code

There are three ways an OpenClaw bot can call an external coding-agent app
that exposes MCP tools and threads:

1. **MCP server (recommended).** Add the app's MCP endpoint under
   `mcp.servers.<name>`: `{command, args}` for stdio, or `{url, headers?}`
   for Streamable HTTP or SSE (`<openclaw>/docs/tools/mcp.md`). Keep
   secrets in env or SecretRefs, never as literals. The tools reach the
   model as **`<server>__<tool>`** and go through the normal tool profile,
   allow, deny and approval policy.
2. **Plugin tool.** `api.registerTool({ name: "t3_send", ... })` wraps the
   app's API. Tool events use the registered name and whatever `details`
   the plugin returns. This allows a clean shape, but the plugin owns the
   transport and auth.
3. **Skill.** A `SKILL.md` that tells the bot to run a CLI through `exec`.
   The events are ordinary `exec` events with command text. They are hard
   to recognize reliably and they go through exec approvals. Avoid this.

What the existing install inspected for this research does: **no skill** under the
default profile's skill folders references T3 Code or MCP. I checked every
`SKILL.md` found there, as permitted; nothing else in that profile was
opened. Whether that install has an MCP server configured for it is
**unverified**: that would need `openclaw.json`, which is off-limits.

Verified tool events for the MCP path. These came from a stand-in server,
`docs/research/dev-gateway/fake-coding-mcp.mjs`, configured as
`mcp.servers.coder` and exposing `send_message({threadId?, message})` and
`list_threads()`. Live:

```text
agent stream:"item" data:{name:"coder__send_message", kind:"tool", phase:"start", title:"Coder Send Message", ...}
agent stream:"tool" data:{phase:"start", name:"coder__send_message", toolCallId, args:{message:"Fix the failing login test"}}
agent stream:"tool" data:{phase:"result", name:"coder__send_message", isError:false,
  result:{content:[{type:"text", text:"structuredContent:\n{…}"}],
          details:{mcpServer:"coder", mcpTool:"send_message",
                   structuredContent:{threadId:"thread-1", reply:"…"}}}}
agent stream:"item" data:{..., phase:"end", status:"completed"}
```

Rendering a "Messaged T3 Code" card:

- Recognize it by `result.details.mcpServer` equal to the configured server
  name, for example `t3code`. Before the result arrives, use the
  `data.name` prefix `<server>__`.
- `args` are the message sent. `details.structuredContent` holds the
  thread id and reply when the server returns structured content. Otherwise
  parse `result.content[0].text`.
- Keep a client-side map from MCP server name to display name and icon,
  such as `t3code` to "T3 Code". Show the raw call behind the card, as the
  parity goals require.

T3 Code's actual MCP transport, endpoint, tool names and auth model are
**unverified** here. I did not inspect the app's configuration, to stay
within the brief. Its real tool names will appear as `<server>__<toolName>`,
whatever server name the owner chooses in `mcp.servers`.

## 6. Risks

- **Protocol stability for third-party clients.**
  - Client ids and modes are closed enums with no third-party slot.
  - Request schemas are closed, so version skew fails loudly.
  - The `methods` list in `hello-ok` is deliberately incomplete.
  - The docs' "verified stable" package (2026.8.1) lags the gateway by about seven
    weeks.
  - Plugin APIs are labeled experimental.
  - Releases are frequent (2026.10.6 to 2026.11.4 in 25 days, with 107
    changed definitions).

  Mitigations: lock client and gateway to the same release, gate features
  on `features.capabilities` and the presence of methods, and run e2e tests
  against that exact gateway in CI.
- **Single trusted operator.**
  - Gateway-authenticated callers are trusted operators. Exec approvals are
    "not a per-user auth boundary" (`<openclaw>/docs/tools/exec-approvals.md`).
  - Many Clawtrate flows need `operator.admin`: bot editing, per-bot policy,
    schedules, the browser view and `chat.inject`. A phone holding admin
    can do anything to the gateway, including `config.*`.

  Mitigations: pair mobile as read, write and approvals by default, with
  admin requested on demand through `device.scopes.requestUpgrade`. Move
  admin-only flows behind narrower plugin methods (P1, P4) where possible.
- **Default exec posture.** An unconfigured gateway ran model-requested
  shell commands with no approval. Clawtrate should show the effective exec
  mode per bot prominently, and warn on `full`.
- **Approvals need caps.** A client that forgets `approvals` or
  `exec-approvals` causes silent denials (`no-route`), not prompts.
- **Attachments.** Base64 in one WebSocket frame: per-file ceilings come
  from `hello-ok.policy.attachments` (observed 18.5 MiB and 6 MiB), the
  frame limit is `policy.maxPayload` (25 MiB), and there is no resumable
  upload. Large files need another path, such as a workspace write by a
  plugin or `terminal.upload`, which is admin.
- **Event volume.**
  - `agent stream:"tool"` frames embed a full session row snapshot.
  - The operator connection received the target bot's run events in a
    bot-to-bot exchange without subscribing to that session.

  Mobile clients should use `mode:"narration"` and `rowMode:"compact"`
  where possible, and test bandwidth.
- **Steer semantics.** These are unverified with a real model. With the
  scripted model, steering interrupted the running reply, and one steer run
  failed with a "no longer current" error.
- **Memory search depends on an index and an embeddings provider.** On a
  fresh profile, search returned nothing until a reindex. The default
  embeddings provider would call a hosted API if a key were present.
- **Personal data in events.** Session rows and message metadata carry the
  gateway owner's display name and avatar URL (`createdActor.label`,
  `senderName`). The probe derived these from the host account. Never
  commit captured event logs or screenshots of real gateways to this
  repository.
- **Gateway shutdown can hang** past SIGTERM (section 4), which matters
  for test harness teardown.
- **Mobile push** depends on a plugin plus a third-party push service
  (row 16). The official relay is closed to other apps.
- **Browser takeover** without arbitration can cause agent and user input
  races until P4 exists.
