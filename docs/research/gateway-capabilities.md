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
`projects.searchRemote` and `worktrees.list` rose from `operator.read` to
`operator.write`, and `users.prefs.set` dropped from `operator.write` to
`operator.read`. Consequences:

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

### Scopes

Every scope below was checked against the gateway's own policy table,
`CORE_GATEWAY_METHOD_POLICY` in `<openclaw>/dist/core-method-policy-DkntKRY_.mjs`.
It classifies all 519 core methods (`listCoreGatewayMethodNames`). Its base scopes match the schema `methods`
map exactly, with no differences. "dynamic" means the gateway decides from the
parameters. Those rules are in `<openclaw>/dist/method-scopes-BdXzw-yD.mjs`
and `<openclaw>/dist/session-method-scopes-base-CuhU2F_D.mjs`, and each row
below gives them.

The closed operator scope set has **ten** scopes (`KNOWN_OPERATOR_SCOPES` in
`<openclaw>/dist/operator-scopes-BO7_XQCg.mjs`): `operator.read`,
`operator.write`, `operator.admin`, `operator.sessions.read`,
`operator.sessions.write`, `operator.approvals`, `operator.questions`,
`operator.pairing`, `operator.talk` and `operator.talk.secrets`.

Implications (`operatorScopeSatisfied` in
`<openclaw>/dist/operator-scope-compat-Ci6GBcmU.mjs`):

- `operator.admin` satisfies every operator scope.
- `operator.write` satisfies `operator.read`, `operator.talk`,
  `operator.sessions.read` and `operator.sessions.write`.
- `operator.read` and `operator.sessions.write` each satisfy
  `operator.sessions.read`.
- `operator.approvals`, `operator.questions`, `operator.pairing` and
  `operator.talk.secrets` are satisfied only by themselves or by admin.

**`operator.sessions.read` and `operator.sessions.write`** are narrower
stand-ins for read and write on session-shaped methods
(`SESSION_READ_METHODS` and `SESSION_WRITE_METHODS` in
`session-method-scopes-base-CuhU2F_D.mjs`; admission in
`authorizeOperatorScopesForRequiredScope`, `method-scopes-BdXzw-yD.mjs`):

- `operator.sessions.read` admits, in place of `operator.read`, exactly these
  37 methods, in source order (`SESSION_READ_METHODS`, lines 4-41):
  `agent.identity.get`, `agents.list`, `canvas.document.preview`,
  `models.list`, `progressCard.get`, `projects.list`,
  `session.suggestions.list`, `session.reactions.list`,
  `sessions.groups.list`, `sessions.processes.list`, `sessions.list`,
  `sessions.subscribe`, `sessions.messages.subscribe`,
  `sessions.messages.unsubscribe`, `sessions.viewers.set`,
  `sessions.preview`, `sessions.describe`, `sessions.branches.list`,
  `sessions.get`, `sessions.github.options`, `sessions.github.status`,
  `sessions.resolve`, `sessions.search`, `sessions.files.list`,
  `sessions.files.get`, `sessions.files.assets`,
  `sessions.setInvolvement`, `chat.history`, `chat.startup`,
  `chat.metadata`, `chat.message.get`, `session.members.list`,
  `session.members.listEvidence`, `themes.get`, `themes.list`,
  `users.prefs.get`, `users.self`.
  `themes.set` and `themes.import` are not in the set; they need
  `operator.write` with no substitute. The session's sharing policy still
  applies.
- `operator.sessions.write` admits, in place of `operator.write`:
  `chat.send`, `chat.abort`, `sessions.create`, `sessions.patch`,
  `sessions.patchMany`, `sessions.fork`, `sessions.recover`,
  `sessions.send`, `sessions.steer`, `sessions.abort`,
  `sessions.processes.stop`, `sessions.goal.update`/`clear`, and
  `question.*` in place of `operator.questions`. This holds only where the
  parameters would not need admin, and "mutation owners must bind the
  caller's own row". In practice it is for the caller's own sessions.
  `sessions.github.publish` requires it directly. A plugin method can accept
  it through `sessionAccess.allowOwnSessionScope`.
- Neither one substitutes for read or write on any method outside these two
  source sets. Two other places name them: `sessions.github.publish`
  requires `operator.sessions.write` directly, and a plugin method may accept
  `operator.sessions.write` through `sessionAccess.allowOwnSessionScope`.
  Clawtrate does not need
  them for its own connection, but a shared or guest device could be paired
  with only these.

**What a connection with `operator.read` alone can do.** This is the
client's first connection, so it matters.

- It can read every bot, session, transcript and live stream:
  `agents.list`, `agent.identity.get`, `agents.files.list`/`get`,
  `agents.workspace.list`/`get`, `sessions.list`/`subscribe`/`describe`,
  `sessions.messages.subscribe`, `chat.history`, `chat.message.get`,
  `chat.metadata` and `artifacts.*`. It receives `chat`, `agent`,
  `session.*` and `sessions.changed` events.
- It can read models and tools (`models.list`, `tools.catalog`,
  `tools.effective`), usage (`usage.status`, `usage.cost`,
  `sessions.usage*`), schedules (`cron.list`, `cron.get`, `cron.status`,
  `cron.runs`, `cron.history`), memory (`memory.status`, `memory.search`,
  `memory.get`), nodes (`node.list`, `node.describe`), `computer.status`,
  `canvas.document.view`/`preview`, `talk.catalog`, `talk.config` without
  secrets, `tts.status`/`providers`/`personas`, `push.web.preferences.get`,
  and `config.get`/`config.schema`/`config.schema.lookup`. Secrets come back
  redacted in `config.get` (live: `__OPENCLAW_REDACTED__`).
- It can call `device.scopes.requestUpgrade` and `device.scopes.waitUpgrade`.
- It cannot send, abort, steer or create (`chat.send`, `chat.abort`,
  `sessions.create` and `sessions.send` need write).
- It cannot see or resolve approvals (`exec.approval.*`,
  `plugin.approval.*`, `approval.*` need `operator.approvals`), list devices
  (`device.pair.list` needs `operator.pairing`), or use talk.
- It cannot get the Web Push key: `push.web.vapidPublicKey` needs write.
  Nor can it touch any `browser.*` method or plugin method registered at
  write.

Live: a read-only device listed sessions and was refused `chat.send` with
`MISSING_SCOPE`/`operator.write`.

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
  live socket (`operator.read`). The requested list must cover the
  connection's current scopes under the implication rules above; it does not
  have to add anything. An equal list is accepted, and `[operator.write]`
  covers a current `[operator.read]`. The handler checks this with
  `roleScopesAllow` (`<openclaw>/dist/devices-mOg4_HQd.mjs` lines 63-70). A
  configured operator role policy also caps the request (lines 54-61). It
  returns `{requestId}`
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
- Changes arrive through `config.changed`, payload `{path, hash, ts}`
  (`<openclaw>/dist/server-reload-managed-*.mjs`, the `config.changed`
  broadcast). It never carries config content. Refetch afterwards.
- **Status: available.** Description is config-only.

### 3. Create, edit and delete a bot

| Field | How | Scope |
| --- | --- | --- |
| name, emoji, avatar, workspace, model | `agents.create {name, workspace?, model?, emoji?, avatar?}` returns `{ok, agentId, name, workspace}`; `agents.update {agentId, name?, workspace?, model?: string\|null, agentRuntime?, emoji?, avatar?}` | `operator.admin` |
| delete | `agents.delete {agentId, deleteFiles?}` returns `{ok, agentId, removedBindings, removed[], failed[]}`; files go to trash | `operator.admin` |
| instructions / system prompt | workspace bootstrap files: `agents.files.list {agentId}`, `agents.files.get {agentId, name}`, `agents.files.set {agentId, name, content, expectedHash?, expectedMissing?}`. `get` and `set` accept `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `BOOTSTRAP.md` and `MEMORY.md` (`ALLOWED_FILE_NAMES`). `agents.files.list` omits `IDENTITY.md` on purpose (`CORE_FILE_NAMES`), and omits `BOOTSTRAP.md` after onboarding (`<openclaw>/dist/agents-DAPW-UCQ.mjs` lines 259-267, 383; names in `<openclaw>/dist/workspace-bootstrap-policy-BQw7Lpx1.mjs`). `TOOLS.md` is not accepted | `operator.read` for list and get; `operator.admin` for set |
| reasoning effort default, tools, exec policy, bot-to-bot targets, description | `config.patch {raw, baseHash}` with a merge patch under `agents.entries.<id>` (`thinkingDefault`, `reasoningDefault`, `tools.{profile, allow, deny, alsoAllow, exec.mode, agentToAgent.send}`, `description`, `identity.*`). `baseHash` comes from `config.get().hash`; without it the patch is refused ("config base hash required") | `config.patch`, `config.set` and `config.apply` are `operator.admin`. `config.get`, `config.schema` and `config.schema.lookup` are `operator.read` |

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
  **`includeApprovals: true` needs more than read.** For a non-admin
  caller it requires `operator.approvals` and a paired device, otherwise
  the call is rejected: "sessions.messages.subscribe includeApprovals
  requires a paired device and gateway scope: operator.approvals"
  (`<openclaw>/dist/sessions-subscriptions-BO608Xgc.mjs` lines 69-72;
  `canReviewOperatorApproval` in
  `<openclaw>/dist/operator-approval-authorization-C9wV2RU-.mjs`). Admin
  bypasses this check. A read-only first connection must leave the flag
  out.
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
  attachments?, ...}` returns `{ok, key, sessionId, entry, runStarted,
  runId?, runError?}` (live). The run starts but has not finished when this
  returns: wait on `runId`, for example with `agent.wait {runId, timeoutMs}`
  (`operator.write`), and check `runError`. Labels must be unique ("label
  already in use", live). Scope is dynamic: `operator.write`, but
  `operator.admin` if `execNode` or `toolOverrides` is present,
  `permissionMode` is `"full"`, or the session is incognito
  (`resolveSessionsCreateRequiredScope`).
- `sessions.patch` is `operator.write` only when every field is one of:
  `label`, `autoLabel`, `icon`, `color`, `category`, `boardFace`,
  `boardPresentation`, `pinned`, `archived`, `snoozedUntil`, `unread`,
  `model`, `agentRuntime`, `thinkingLevel`, `fastMode`, or a
  `permissionMode` other than `"full"`. The only other fields allowed at
  write are `key`, `agentId`, `expectedSessionId`,
  `expectedLifecycleRevision`, `expectedPermissionMode` and
  `expectedMarkedUnreadAt`. Any other field needs `operator.admin`:
  - `reasoningLevel`, `contextWindow`, `toolOverrides`, `execHost`,
    `execNode`, `execSecurity`, `execAsk`, `sandboxMode`, `verboseLevel`
    and so on;
  - the guards `expectedToolOverrides`, `expectedSandboxMode` and
    `expectedNativeRuntimeConsent`. Adding one of these to a label-only
    patch makes it admin.

  Source: `SESSIONS_PATCH_WRITE_SCOPE_MUTATIONS`,
  `SESSIONS_PATCH_WRITE_SCOPE_ENVELOPE_FIELDS` and
  `resolveSessionsPatchRequiredScope`,
  `<openclaw>/dist/session-method-scopes-base-CuhU2F_D.mjs` lines 68-110.
- `sessions.delete` is `operator.write` only when `archivedOnly: true` and
  every key is one of `key`, `agentId`, `deleteTranscript`,
  `expectedSessionId` and `archivedOnly`. Anything else is
  `operator.admin`, including the valid guards `expectedLifecycleRevision`,
  `expectedSessionUpdatedAt` and `emitLifecycleHooks`
  (`SESSIONS_DELETE_WRITE_SCOPE_FIELDS` and
  `resolveSessionsDeleteRequiredScope`, same file, lines 94-100 and
  116-118). `sessions.describe {key}` (`operator.read`)
  returns one full row (live).
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
- Steer: `sessions.steer` (`operator.write`; not advertised, and its params
  are not in the published schema) is a **"Deprecated alias for chat.send
  queueMode interrupt"** (policy-table description,
  `<openclaw>/dist/core-method-policy-DkntKRY_.mjs` line 1856). That is why
  it interrupted, live: `{key, message}` returned
  `{runId, status:"started", interruptedActiveRun:true}`. Do not use it;
  use `chat.send` with an explicit `queueMode`. Separately,
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
  `get`). Per session, `sessions.patch {permissionMode}` is `operator.write`
  except for `"full"`. `sessions.patch {execSecurity, execAsk}` needs
  `operator.admin` (row 4).
- **Important default:** with no exec policy configured, the probe gateway
  resolved `security: "full", ask: "off"`. The scripted model's `exec`
  ran `uname -s` with no approval (live). Policy has to be global, because a
  bot created later inherits only the global value. The section 4 template
  sets `tools.exec.mode: "ask"`. Live: a bot created afterwards by
  `agents.create`, with no override, requested approval for `uname -s` with
  `security: "allowlist", ask: "on-miss"`.
- Approval rules for tools other than exec, for example "ask before Pixel
  messages another bot" or "ask before browser navigation", have no config
  surface. A plugin `before_tool_call` hook can return `requireApproval`
  (source: `<openclaw>/docs/plugins/hooks/tool-policy.md`). See plugin P5.
- Scope summary: every listing, event and resolve path needs
  `operator.approvals`, which `operator.write` does not imply. Policy edits
  need `operator.admin`.
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
  - `payload` is one of four kinds:
    - `{kind:"agentTurn", message, model?, fallbacks?, thinking?,
      timeoutSeconds?, lightContext?, toolsAllow?}`;
    - `{kind:"systemEvent", text, toolsAllow?}`;
    - `{kind:"command", argv, cwd?, env?, input?, timeoutSeconds?,
      outputMaxBytes?, toolsAllow?}`;
    - `{kind:"script", script, timeoutSeconds?, toolBudget?, toolsAllow?,
      toolsAllowIsDefault?}`.

    Source: `schema` `definitions.CronAddParams.properties.payload`.
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
- With `memory.search.provider: "none"` (the section 4 template),
  `memory.status` reports provider `none` and `memory.search` uses local
  full-text search only. Live: after `MEMORY.md` was written, search for a
  word in it returned that file, with `searchMode: "fts-only"`.
- Edit: memory is Markdown in the bot workspace. `MEMORY.md` is read and
  written through `agents.files.get`/`agents.files.set` (admin for set;
  live). Dated notes under `memory/` are refused by
  `agents.files.set` ("unsupported file"). They can be read through
  `agents.workspace.list {agentId, path?}` and
  `agents.workspace.get {agentId, path}` (live for `MEMORY.md`). Maintenance
  methods: `doctor.memory.status` and `doctor.memory.dreamDiary`
  (`operator.read`), the other `doctor.memory.*` repair methods
  (`operator.write`), and `migrations.memory.plan`/`apply`
  (`operator.admin`).
- Delete: there is no RPC to delete one memory item or file.
- A dated note written straight into `<workspace>/memory/` was **not**
  returned by `memory.search` within 13 s (live). The docs say memory files
  are watched and reindexed with a debounce
  (`<openclaw>/docs/concepts/memory-builtin.md` line 154). Which paths are
  watched, and how fast, is **unverified**.
- **Status: partial.** Read works. Editing through RPC covers only
  `MEMORY.md` and needs admin. There is no delete. See plugin P2.

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
- Per session: `sessions.patch {key, model, thinkingLevel, fastMode}` is
  `operator.write` (live with `model:"fake/scripted", thinkingLevel:"high"`).
  `reasoningLevel` and `contextWindow` make the same call `operator.admin`
  (row 4). Model refs are
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
  `node.rename` (`operator.pairing`). `node.pair.approve` adds a check based
  on the commands the node declares (`resolveNodePairApprovalScopes`,
  `<openclaw>/dist/node-pairing-authz-_-5BGyuw.mjs` lines 4-12):
  - no commands: `operator.pairing`;
  - any commands: `operator.pairing` plus `operator.write`;
  - any of `system.run.prepare`, `system.run`, `system.which`,
    `system.execApprovals.get`, `system.execApprovals.set`,
    `browser.proxy`, `browser.proxy.upload.v1`, `fs.listDir` or
    `terminal.upload`: `operator.pairing` plus `operator.admin`. Invoke with
  `node.invoke {nodeId, command, params?, idempotencyKey}` (dynamic:
  `operator.write`, or `operator.admin` for the admin-only node commands,
  which are the browser proxy commands, `fs.listDir` and terminal upload
  (`NODE_ADMIN_ONLY_INVOKE_COMMANDS` in
  `<openclaw>/dist/node-commands-Bxo-2Y4j.mjs`; dispatch in
  `method-scopes-BdXzw-yD.mjs`).
  Events: `node.pair.requested`, `node.pair.resolved`, `node.presence`,
  `node.hostStats`, `node.runnerInventory.changed` and
  `node.invoke.request`.
- Choosing where a bot's tools run:
  - per session, `sessions.patch {execHost, execNode}` and
    `sessions.create {execNode}` (`schema`). Both need **`operator.admin`**
    (row 4);
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
- Per session: `sessions.patch {permissionMode: read-only|guarded|workspace}`
  and `sessions.create {permissionMode}` are `operator.write` (live with
  `permissionMode:"guarded"`).
  - `permissionMode: "full"` and `toolOverrides` need `operator.admin` on
    both methods.
  - `execSecurity`, `execAsk` and `execHost` exist only on
    `sessions.patch`, where they need `operator.admin`. `sessions.create`
    has a closed schema that rejects all three, even for admin (`schema`
    `SessionsCreateParams`, row 4).
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
  `push.web.test` and `push.web.preferences.set` are `operator.write`;
  `push.web.preferences.get {endpoint}` is `operator.read`. Payloads are generic, and a tap opens the
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

- Talk methods need `operator.talk`, which `operator.write` also satisfies:
  `talk.mode {enabled, phase?}`, `talk.speak`, the gateway-relayed realtime
  audio methods `talk.session.create`, `appendAudio`, `cancelOutput`,
  `acknowledgeMark`, `submitToolResult`, `steer` and `close`, the
  client-owned realtime methods `talk.client.create`, `transcript`,
  `toolCall`, `steer` and `close`, and `talk.voice.get`/`set`/`complete`.
- `talk.catalog` is `operator.read`. `talk.config` is dynamic: `operator.read`,
  but with `includeSecrets: true` it needs both `operator.read` **and**
  `operator.talk.secrets`; admin satisfies both (`method-scopes-BdXzw-yD.mjs`,
  the `talk.config` branch).
- TTS is not covered by `operator.talk`. `tts.status`, `tts.providers` and
  `tts.personas` are `operator.read`. `tts.enable`, `tts.disable`,
  `tts.convert`, `tts.setProvider`, `tts.setPersona` and `tts.speak` are
  `operator.write` (policy table).
- Events: `talk.event`, `talk.mode` and `talk.voice.change`.
- Multi-agent gateways need `talk.agentId` in config. Without it,
  `talk.catalog` failed with `AGENT_SELECTION_REQUIRED` (live).
- **Status: available** by schema. Not exercised beyond that error.

### 18. The bot's computer

> **Status of the computer-view work.** Plugin P4 below is a **research
> prototype**. It demonstrates that the view and takeover are feasible for
> an ordinary plugin. It has **not** passed a security review for shipping
> and must not be installed outside a development gateway. Builders write
> the shipped plugin from "Requirements for the shipped plugin" in
> section 3.

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

Caveats of the built-in route:

- `operator.admin` is required for the free-form browser. A non-admin
  connection is refused with `MISSING_SCOPE`/`operator.admin` (live, from a
  read and write device). It can use only `browser.dashboard.request`
  against a `browser:dashboard` widget in its own session.
- There is **no takeover arbitration** for the gateway browser. Agent and
  user input interleave. The takeover pause the docs describe exists only
  for cloud-worker desktops (`<openclaw>/docs/nodes/computer-use.md`).
- Headful launch is the default. Development gateways should set
  `browser.headless: true`.
- Screencast is unsupported for Chrome MCP existing-session profiles and for
  node-routed browsers (HTTP 501 or `SCREENCAST_UNSUPPORTED`). The Control
  UI falls back to `POST /screenshot` polling.
- Built-in screencast sessions are keyed by `${profileName}:${targetId}`
  (`<openclaw>/dist/session-Dy6QNgnj.mjs` line 256). The resource is a tab
  in a browser profile, not a chat session. By default the managed
  `openclaw` profile is shared by every session and every bot that uses the
  browser tool. Plugin P4 gives each bot its own profile.

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

**Answer to the milestone question: (a) is true, demonstrated again with the
fixed prototype on the probe gateway.** An ordinary plugin, loaded into one
profile, gave a client holding only `operator.read` and `operator.write` a
live view of the bot's browser and control of a tab. The client never had
`operator.admin`. The prototype is `docs/research/dev-gateway/computer-plugin/`
(no dependencies, offline tests in `test.mjs`). The design and its exact
limits are in section 3, plugin P4.

**Isolation model: one browser per bot.** Each configured bot gets its own
managed browser profile (`browser.profiles.bot-atlas`, `bot-pixel`, each with
its own debugging port).
- The plugin's `before_tool_call` hook rewrites every `browser` call from
  that bot to use the bot's profile on the host browser (`target: "host"`).
- The hook handles both kinds of caller:
  - Configured bots may use only tab actions. Node, sandbox, dashboard and
    import routing are refused for them.
  - Other agents are refused any bot profile, whether named in `profile`
    or `into` (with the browser tool's trimming) or reached by default.
- A session may view or control exactly the tabs in its own bot's browser,
  as listed live by that browser's CDP endpoint. Nothing is inferred from
  tool results.
- All sessions of the same bot share that bot's browser and its view.
- Tabs an operator opens in the bot's profile through `browser.request` are
  part of that browser and are viewable by the bot's sessions.

Live result on a fresh profile, under a temporary `HOME` started by
`dev-gateway.sh`. Two non-admin viewer devices, A and B: each had
`hello-ok.auth.scopes` `["operator.read","operator.write"]`, and
`browser.request` was refused with `MISSING_SCOPE`.

1. **Pinning is host-authoritative.**
   - Atlas ran `browser open https://example.com`, then
     `browser open https://example.org` with `profile: "bot-pixel"` in the
     call. Pixel ran `browser open https://example.net`.
   - The browser tool's own results reported `browserTab.profile` as
     `bot-atlas`, `bot-atlas` and `bot-pixel`. Atlas's browser (port 19113)
     held example.com and example.org; Pixel's (port 19114) held
     example.net. The shared `openclaw` profile was never started.
   - Atlas's call with `target: "node"` was blocked by the hook.
2. **Operator tabs.** An admin `browser.request POST /tabs/open` with
   `query.profile: "bot-atlas"` opened a tab, and it appeared in
   `clawtrate-computer.tabs` for Atlas's session.
3. **Cross-bot refusal.** `view.open` on Atlas's tab from Pixel's session
   was refused: "tab is not in this bot's browser".
4. **Frames.** A one-use ticket from `view.open` opened
   `/clawtrate-computer/stream`. Frames used the built-in binary layout and
   header, `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`. The first
   was a valid 756×469 JPEG; 24 frames arrived over the run.
5. **Takeover during a short call.** A 4 s bot browser call was running.
   `control.take` emitted the `draining` event and blocked new bot calls.
   It responded once, `{state:"granted", generation}`, 3.9 s later, after
   the call finished.
6. **Bot blocked.** While the user held control, the bot's next `browser`
   call returned the tool error "The user has control of this bot's
   browser".
7. **Lease holder.** Viewer B's `control.release` was refused, both without
   a generation and with A's generation copied: "only the current holder
   can release, with its generation". B's `control.take` was refused:
   "already held".
8. **Input.** `input` with `scroll` and `click`, carrying A's generation,
   worked. 22 new frames followed, and `scrollY` moved from 0 to 243.
9. **Release.** After `control.release` by A, the bot's next `browser` call
   succeeded.
10. **Fail closed.** A 25 s bot call was running when the user tried to take
    control. The take responded `{state:"busy", reason:"the bot is still
    acting in this browser", runningCalls:1}` after the 15 s drain budget,
    and left no lease. After the call finished, a retry was granted.
11. **Disconnect.** The holder dropped its gateway connection without
    releasing. The stream closed with `4006 authority_revoked` 17.6 s
    later, once renewals stopped. Viewer B saw the lease as `null` 22.6 s
    after the disconnect.

What the user must approve, compared with the built-in route:

- **With the plugin:** the client pairs as `operator.read` plus
  `operator.write`. The gateway owner configures one browser profile per
  bot and the plugin's `bots` map. No admin grant goes to the device.
- **Without the plugin:** the client must request `operator.admin`. On
  first pairing, include it in `connect.params.scopes`; later, use
  `device.scopes.requestUpgrade` with the current scopes plus
  `operator.admin`. The owner approves the pending request with
  `device.pair.approve` or `openclaw devices approve <requestId>`. The
  client then calls `browser.request {method:"POST", path:"/screencast"}`.
  That grant also covers config writes, agent edits and every other admin
  method.

**Status: partial** in the gateway. **Available with plugin P4**, for bots
configured with their own browser profile, within the limits under P4.

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
- `api.on("after_tool_call", handler)` receives `{toolName, params, runId,
  toolCallId, result, error, durationMs}` and a context with `agentId`,
  `sessionKey` and `sessionId`. Live: for the `browser` tool,
  `result.details` carried `targetId` and `browserTab{targetId, profile}`.
- `api.pluginConfig` holds the plugin's own config block,
  `plugins.entries.<id>.config`, validated by the manifest's `configSchema`
  (live).
- `sessionAccessAuthority` is handed to handlers registered with
  `sessionAccess`. It has `target{agentId, sessionKey, sessionId}`,
  `assertCurrent()` and `retain()` (types in `config-contracts-C65kIjn4.d.ts`,
  `GatewaySessionAccessAuthority`). The only `sessionAccess.mode` is
  `"write"`.
- **Not available to user-installed plugins:**
  - `api.runtime.gateway.request` throws "Gateway requests are only
    available to bundled or trusted official plugins"
    (`<openclaw>/dist/server-plugins-BDDXcpzF.mjs` line 953). It would also
    carry only `operator.write`
    (`<openclaw>/docs/plugins/sdk-runtime/gateway-and-nodes.md`). A plugin
    therefore cannot call `browser.request`.
  - The same gate covers session facts, profile identity and GitHub account
    lookup (same file, lines 390, 638 and 923).
  - The `plugin-sdk/browser-config` and `plugin-sdk/browser-cdp` subpaths
    are private host runtime, not third-party contracts
    (`<openclaw>/docs/plugins/sdk-subpaths.md`).
  - No hook intercepts gateway methods. Hooks see agent tool calls only, so
    a plugin cannot stop an operator's `browser.request` or
    `browser.dashboard.request`.
- **Module instances:** the host loaded the plugin module more than once.
  State written by the `after_tool_call` hook was not visible to the
  gateway-method handler until it moved to a `globalThis` slot (live). The
  same slot survives plugin replacement. Plan for both.
- **Service ids are global.** Two plugins that both registered a service
  with id `events` collided ("service already registered: events"), and the
  second plugin's service did not start (live). Prefix service ids with the
  plugin id.

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

Each step names its entry point and the authority it needs. "Shown" means
demonstrated on the probe gateway; everything else is **unverified**.

**P1, `clawtrate-bots` (row 3, partial).** One typed bot editor.

- `clawtrate-bots.get {agentId}` and
  `clawtrate-bots.update {agentId, expectedRevision, patch}`, registered with
  `api.registerGatewayMethod` at `scope: "operator.admin"`. That is the
  same authority as `agents.update` and `config.patch` today; the gain is
  one validated call instead of several.
- Config writes would use `api.runtime.config.mutateConfigFile`, and
  bootstrap files would be written into the workspace that
  `api.runtime.agent.resolveAgentWorkspaceDir(cfg, agentId)` returns. Both
  are listed in `PluginRuntimeCore` (`config-contracts-C65kIjn4.d.ts`) and
  are not in the official-only gate list above, but neither was called from
  a user-installed plugin: **unverified**.
- Event `plugin.clawtrate-bots.changed {agentId, revision}` through the
  service's `ctx.gatewayEvents.emit` (emission shown with the probe plugin).

**P2, `clawtrate-memory` (row 10, partial).**

- `clawtrate-memory.list`, `read`, `write` and `delete`, each `{agentId,
  path, content?, expectedHash?}`. They are registered at `operator.admin`,
  matching `agents.files.set`. Paths are confined to `MEMORY.md` and
  `memory/**/*.md`.
- Files are located with `api.runtime.agent.resolveAgentWorkspaceDir`
  (**unverified** from a user plugin) and changed with plain `node:fs`
  writes. The plugin runs in the gateway process with its file access.
- Reindex: there is no runtime method for it; `PluginRuntime` has none. The
  plan relies on the memory backend's file watcher
  (`<openclaw>/docs/concepts/memory-builtin.md` line 154). A live direct
  write under `memory/` was **not** picked up by `memory.search` within
  13 s, so this step is unverified and may need a reindex path. Options to
  test are `openclaw memory status --index --agent <id>`, run by the plugin
  as a subprocess, or confirming the watcher's paths and debounce.
- Event `plugin.clawtrate-memory.changed {agentId, path}`.

**P3, `clawtrate-push` (row 16, missing).**

- `clawtrate-push.register {expoPushToken, platform}` and `unregister`, at
  `operator.write`. The token is kept in plugin state, keyed by the
  caller's paired device id from the method's `client` argument.
- Triggers would come from `api.runtime.events.onAgentEvent` (listed in
  `PluginRuntimeCore`) for run completion, and from a `before_tool_call` /
  `after_tool_call` pair for tools that wait on approvals. No plugin-facing
  subscription to `exec.approval.requested` was found.
- Sending to Expo's push service is an outbound call from the gateway host;
  make it opt-in. Nothing in P3 was demonstrated: **unverified**.

**P4, `clawtrate-computer` (row 18).** Live view and user takeover of a
bot's own browser, without `operator.admin`. The prototype is
`docs/research/dev-gateway/computer-plugin/index.js`, with offline tests in
`test.mjs` beside it (`node test.mjs`, no gateway needed). Everything in the
table was **shown** live (row 18) unless marked.

Plugin config (`plugins.entries.clawtrate-computer.config`), with each
profile also declared under `browser.profiles` with the same port:

```json
{ "bots": { "atlas": { "profile": "bot-atlas", "cdpUrl": "http://127.0.0.1:19113" },
            "pixel": { "profile": "bot-pixel", "cdpUrl": "http://127.0.0.1:19114" } },
  "drainTimeoutMs": 15000 }
```

Entry points and authority:

| Step | Entry point | Authority and checks |
| --- | --- | --- |
| Give each bot its own browser | `api.on("before_tool_call")` for `toolName === "browser"`. Selectors are read the way the tool reads them: trimmed, with empty meaning absent. A configured bot may use only `status`, `start`, `tabs`, `open`, `focus`, `close`, `snapshot`, `screenshot`, `navigate`, `text` and `act`. Other actions, `importprofile` among them, are refused, and so are `node`, `dashboard`, `into` and any `target` but `host`. The hook then returns `{params: {...params, action, profile: <bot profile>, target: "host"}}`. Another agent is refused a bot profile named in `profile` or `into`, and `dashboard` selectors. The plugin refuses to load if `browser.defaultProfile` is a bot profile | Hook context's `agentId`, from the host. The browser tool's own result reported the pinned profile (live). With `target: "host"`, the tool never picks a node or sandbox, and refuses when host control is not allowed (`<openclaw>/dist/browser-request-CRdbSjXm.mjs` lines 1567 and 1593). The allowlist, target pin and import refusal were checked offline only |
| List, view, take, release, renew, input | `api.registerGatewayMethod("clawtrate-computer.*", …, { scope: "operator.write", sessionAccess: { mode: "write", requiredTool: "browser" } })` | The host checks the session, sharing and the session's browser tool policy. The plugin maps `sessionAccessAuthority.target.agentId` to that bot's browser and requires the tab to be in its live CDP target list |
| Stream | `api.registerHttpRoute({ path: "/clawtrate-computer/stream", auth: "plugin", handleUpgrade })` with a hand-written WebSocket handshake | One-use, 60 s, 192-bit ticket from `view.open`, deleted before any await. The stream closes when `view.renew` stops for 20 s, when the retained session authority fails, or when the tab goes away |
| Frames and input | CDP over the target's debugger URL: `Page.startScreencast`, `Page.screencastFrameAck`, `Input.dispatchMouseEvent`, `Input.insertText` (Node's global `fetch` and `WebSocket`) | Each `cdpUrl` must be the literal `http://127.0.0.1:<port>` or `http://[::1]:<port>`, or the config is rejected. Discovery uses `redirect: "error"`. A target is used only if its `webSocketDebuggerUrl` is exactly `ws://<same host>:<same port>/devtools/page/<id>` |
| Block the bot while the user drives | the same `before_tool_call` hook returns `{block: true, blockReason}` while any lease exists on that bot's profile | Only that bot's browser calls are affected, from all its sessions |
| Track running bot calls | `before_tool_call` records the host's run id and tool call id together; `after_tool_call` removes only the matching record, and only for the same agent. A browser call without both ids is refused | The same `runId:toolCallId` identity the host uses for its own call bookkeeping |
| Events | `ctx.gatewayEvents.emit("control", …)` gives `plugin.clawtrate-computer.control {profile, targetId, holder, state}`, with states `draining`, `granted`, `busy`, `released`, `expired`, `revoked` and `tab-closed` | Scope `operator.read`: every reader sees it, not only that bot's sessions |

Contract:

- **`control.take {sessionKey, targetId}`.**
  - It emits a `draining` event at once and blocks new bot calls on the
    bot's profile. It sends **one** response after the wait: `{state:
    "granted", generation, renewWithinMs}` or `{state: "busy", reason,
    runningCalls}`.
  - There is no `draining` response; show that state locally, or from the
    event.
  - If a bot browser call is still running after `drainTimeoutMs` (default
    15 s), the take **fails closed**: no lease remains, and the client should
    say "the bot is still acting" and let the user retry. It returns
    `CONFLICT` if anyone holds or is taking the tab.
- **`control.release` and `input`.** These need the holder's connection and
  the lease's `generation`, an unguessable 128-bit id. Other viewers get
  `FORBIDDEN`. Input, release and expiry run one at a time on each lease. Input rechecks that the lease is still the same one, still
  granted and still authorized after connecting and before every CDP
  command. Input that started under a lease cannot land after that lease
  ends (offline test C-03b).
- **`view.renew {sessionKey, targetId, streamId, generation?}`.** This does
  two separate renewals.
  - Stream renewal: any viewer admitted to the tab's bot renews its own
    stream (`streamId` from its `view.open`). The stream must match that
    bot and tab, otherwise the reply is `NOT_FOUND`.
  - Lease renewal: the lease is renewed as well only when the call comes
    from the lease holder's connection with the current `generation`.
  - The reply is `{ok: true, renewWithinMs, leaseRenewed}`. A missing or
    wrong `generation`, or another viewer's call, still renews the stream,
    but returns `leaseRenewed: false` and leaves the lease's expiry clock
    alone.
- **`input {kind: "click"|"scroll"|"text", x?, y?, deltaY?, text?}`.**
  Scroll uses a CDP wheel event.
- **Frames.** They use the built-in screencast's binary layout and header,
  `{url, cssWidth, cssHeight, scrollX, scrollY, ts}`, so one decoder serves
  both. Text messages are `ready` and `meta`. Close codes are `4004
  target_closed`, `4006 authority_revoked` and `1000` on close.

Limits:

- **Isolation is per bot, not per session.** Sessions of the same bot share
  its browser, and so share what they can view and take. Tabs opened in the
  bot's profile by an operator through `browser.request` are part of that
  browser, and are viewable by the bot's sessions (live).
- **The block is per bot, not per tab.** While a user holds one tab, all of
  that bot's browser calls are refused. Bot calls name tabs by handles such
  as `t1` that a plugin cannot resolve.
- **Unconfigured bots** keep using the shared `openclaw` profile and get no
  view. While bots have their own browsers, unconfigured agents also lose
  browser dashboards, because a dashboard widget can name any profile.
- **Operators are not blocked.** `browser.request` (admin) and
  `browser.dashboard.request` (write) are gateway methods, and no hook
  reaches them, so an admin client or a dashboard widget can still drive a
  bot's browser during a lease. The bot itself might reach the browser by
  other means the hook does not cover, such as `exec`. That is not
  verified either way.
- **A stuck call keeps takeover unavailable.** A bot call that never
  produces `after_tool_call` keeps that bot's takeover busy until the
  gateway restarts. The plugin cannot cancel the call. `agent_end` would
  give run-level cleanup, but user-installed plugins need
  `hooks.allowConversationAccess` to use it
  (`<openclaw>/dist/registry-Ctt4xQAS.mjs` lines 2597-2607 and 2830).
  Whether `after_tool_call` fires for an aborted run is **unverified**.
- **Not bound to the connection.** Plugins receive no connection-closed
  signal, and `sessionAccessAuthority.retain()` did not abort when the
  viewer disconnected (live). Streams and leases therefore expire through
  renewal: call `view.renew` about every 5 s, passing the lease's
  `generation` while holding control. Each renewal re-runs the host's
  session access check.
- **Policy bypass.** Frames and input go straight over CDP, so they skip
  the browser plugin's navigation checks: a user click can follow a link
  the bot could not open. The prototype reports `meta` on navigation; it
  does not retire the stream or recheck the URL as the built-in stream
  does.
- **Config is trusted.** The owner's `bots` map decides which profile
  belongs to which bot. Each profile's `cdpPort` in `browser.profiles` must
  match the plugin's `cdpUrl`; the plugin does not read the browser config.
- **Not demonstrated live:** `text` input, the `computer` tool,
  node-routed browsers, an unconfigured agent naming a bot profile (covered
  only by the offline test), and two viewers taking at the same moment
  (the second gets `CONFLICT` in code and in the offline test).

**P5, `clawtrate-tool-rules` (row 8, partial for non-exec tools).**

- An `api.on("before_tool_call")` handler reads a per-bot rule table from
  `api.pluginConfig`, `{agentId, tool, action: "allow"|"ask"|"deny"}`, and
  returns `block` (shown in P4) or `requireApproval`. `requireApproval` is
  **unverified**; it should surface as `plugin.approval.requested` and be
  resolved with `plugin.approval.resolve`.
- Methods `clawtrate-tool-rules.get` and `set` at `operator.admin`.

No plugin is proposed for rows 13 and 17: the surface exists but was not
exercised. For steer (row 5), a test is needed first, not a plugin.

### Requirements for the shipped plugin

The P4 prototype is a feasibility demonstration, not a shippable plugin.
Builders write the shipped computer-view plugin from this list. Each item is
meant to be checked by a test or a review finding.

**Security review.**

- [ ] The shipped plugin gets its own security review before it is installed
      on any gateway other than a development gateway. Passing the
      prototype's tests does not count.

**Browser isolation (fixed in the prototype; keep and test).**

- [ ] Read every selector the way the browser tool reads it before any
      ownership check: strings trimmed, empty meaning absent. Cover the
      omitted profile, which resolves to `browser.defaultProfile` or
      `openclaw`. Refuse configurations where the default is a bot's
      profile. (R3-01; tests R3-01a-c.)
- [ ] Track bot browser calls by the host's run id and tool call id
      together. Refuse a call that lacks either. Remove only the matching
      record, and only for the same agent. (R3-02; tests R3-02a-c.)
- [ ] Refuse `importprofile` for bot callers. Refuse imports into a
      reserved bot profile, by trimmed `into`, from every agent the hook
      sees. (R3-03; test R3-03.)
- [ ] Allow bots only an explicit list of tab actions, and refuse
      everything else. The prototype allows `status`, `start`, `tabs`,
      `open`, `focus`, `close`, `snapshot`, `screenshot`, `navigate`, `text`
      and `act`. Extend it only after review. (Test R3-03b.)
- [ ] Pin every rewritten bot call to `target: "host"` and the bot's
      profile. Refuse node, sandbox and dashboard selectors. Refuse the
      call when host browser control is not allowed, rather than routing
      elsewhere. (R3-05; test R3-05.)
- [ ] Derive view and control rights only from the host-checked session's
      agent and that bot's live CDP target list. Never derive them from
      tool results. (Tests C-01a-d.)

**Takeover and lease (fixed in the prototype; keep and test).**

- [ ] Fail closed: if a bot call is still running at the drain deadline, do
      not grant control. (Test C-02a.)
- [ ] Only the holder, with the lease generation, can release or send
      input. Run input, release and expiry one at a time. Recheck the lease
      and authority before every command. (Tests C-03a-b.)
- [ ] Use CDP endpoints only on literal loopback, with no redirects, and
      only with a debugger URL on the same address and port. (Tests
      C-05a-c.)

**Deadlines and cancellation (N-01, not done in the prototype).**

- [ ] Put deadlines on CDP discovery, WebSocket connect and every command
      reply.
- [ ] Cancel aborts through setup and active commands. Close connections
      that finish opening after their stream or lease ended.
- [ ] Settle queued input before returning control to the bot. Release,
      expiry and service shutdown must complete even when a transport stage
      is stalled. Test each stage stalled.
- [ ] Define how replacing a browser or profile retires its streams and
      leases.

**Tests still missing (N-02, not done in the prototype).**

- [ ] A positive control: a valid click, text and scroll must actually be
      dispatched.
- [ ] Delayed revocation of the retained session authority during a stream
      and during input; lease expiry; serialization at the command level.
- [ ] A debugger URL on the right loopback address but the wrong port must
      be refused. Cover IPv6, credentials in the URL, other schemes, and a
      simulated redirect, not only the fetch option.

**Stated limits the shipped plugin must address or document.**

- [ ] Operator gateway calls (`browser.request`, `browser.dashboard.request`)
      bypass the tool hooks and can drive a bot's browser during a user
      takeover.
- [ ] Direct CDP input and frames skip the browser plugin's navigation
      policy.
- [ ] A takeover blocks browser calls from every session of the bot, not
      one tab.
- [ ] Other tools may reach a browser outside the `browser` tool hook,
      such as the `computer` tool or `exec`. Account for them in the
      isolation policy.

## 4. Development gateway recipe

Everything here was run against an isolated profile and port, and is
committed under `docs/research/dev-gateway/`:

| File | Purpose |
| --- | --- |
| `dev-gateway.sh` | `start`, `check-env`, `stop` and `reset`. Refuses unsafe profile names and any existing state folder, so every start uses a new, empty one. Runs everything under a controlled environment, records real PIDs, and stops with a kill-after-timeout. |
| `fake-openai.mjs` | Scripted fake model provider: OpenAI Chat Completions streaming on loopback, no dependencies. |
| `openclaw.dev.json` | Gateway config template, described below. It loads the two plugins below from the checkout. |
| `seed.mjs` | Creates bots and tasks, waits for every run, and verifies the transcripts; exits non-zero on any failure. |
| `fake-coding-mcp.mjs` | Stand-in coding-agent MCP server (section 5). |
| `probe-plugin/` | Minimal plugin proving methods, events and routes (section 3). Also reports the gateway's environment variable names for `check-env`. |
| `computer-plugin/` | Prototype of plugin P4: browser view and takeover without admin (section 3), with offline tests. |

Profile and port: the project uses `--dev` (state in `~/.openclaw-dev`, port
19001). The launcher deliberately refuses that profile: it accepts only names
matching `^[a-z0-9]+(-[a-z0-9]+)*-(dev|probe)$`, such as `clawtrate-dev`, and
never `default` in any letter case. The template's gateway port is 19101.
Another port needs a change in the template, `PORT` in the script, and the
`cdpPort` values.

```bash
# 1. Start: refuses unsafe names and any existing state folder,
#    creates a new profile from the template, starts the fake model and the gateway
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh start

# 2. Ask the running gateway which environment variable names it really has
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh check-env
#   ... "ok: the gateway sees only the launcher's variables"

# 3. Seed and verify (needs @openclaw/gateway-client@2026.10.6 installed)
OPENCLAW_DEV_URL=ws://127.0.0.1:19101 \
OPENCLAW_DEV_TOKEN="$(cat "${TMPDIR:-/tmp}/openclaw-clawtrate-dev-run/token")" \
  node docs/research/dev-gateway/seed.mjs

# 4. Stop, then delete the profile the launcher created
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh stop
PROFILE=clawtrate-dev docs/research/dev-gateway/dev-gateway.sh reset
```

### Isolation: what the template does and what it does not

The development gateway must not reach a real model or a hosted service with
the developer's credentials. Model routing alone does not guarantee that.

- **Profile selection.** OpenClaw maps `--profile <name>` to
  `~/.openclaw-<name>`, but `default`, in any letter case, maps to the real
  `~/.openclaw` (`resolveProfileStateDir`,
  `<openclaw>/dist/profile-utils-BsmgdpgZ.mjs`).
  - The launcher validates the name before it touches any file. It then
    resolves the state folder once, and passes `OPENCLAW_STATE_DIR`,
    `OPENCLAW_CONFIG_PATH` and `OPENCLAW_PROFILE` explicitly with
    `--profile`, so the script and the CLI cannot disagree.
    `applyCliProfileEnv` keeps explicit values that do not point at the
    default profile (`<openclaw>/dist/profile-D1GpjMFM.mjs` lines 83-96).
  - Live, under a temporary `HOME`: `default`, `Default`, `DEFAULT`, `dev`,
    an empty name, `roster`, `../roster-probe`, a name with `/../` and
    `Roster-Probe` were all refused (exit 2), and the temporary `HOME` was
    still empty afterwards.
- **State reuse.** At startup OpenClaw loads `<state>/.env` and
  `<config dir>/.env`. It also loads `~/.config/openclaw/gateway.env` unless
  the state folder is explicit and not the default
  (`resolveGlobalDotEnvFiles`, `<openclaw>/dist/dotenv-global-CNTZ1AEX.mjs`
  lines 118-135; `createTrustedGatewayEnvLoader`,
  `<openclaw>/dist/pre-bootstrap-fvJUb9k2.mjs` lines 336-358).
  - `env -i` alone therefore does not keep credentials out, and this
    release also keeps model credentials in SQLite state. So the launcher
    does not try to prove an old folder clean. `start` refuses whenever the
    state folder already exists, or is a symlink, and names the reset
    command. It then creates the folder with plain `mkdir`, so it never
    reuses one. `reset` deletes only a folder carrying the launcher's marker
    file `.clawtrate-dev-gateway`.
  - Tested under a temporary `HOME`, without starting a gateway: an existing
    marked folder containing `state/openclaw.sqlite`, and a symlinked state
    folder, were both refused with exit 3, and nothing was started.
- **Environment.** OpenClaw resolves provider credentials from environment
  variables per provider (`resolveEnvApiKey` in
  `<openclaw>/dist/model-auth-env-dEPoNA3I.mjs`).
  - The launcher starts the fake model and the gateway with `env -i`. It
    passes `HOME`, `PATH`, `TMPDIR`, `DO_NOT_TRACK=1`,
    `OPENCLAW_DEV_TOKEN` and the three `OPENCLAW_*` location variables.
  - `check-env` asks the running gateway, after OpenClaw's own loaders,
    for its variable names, through the admin-only probe-plugin method
    `clawtrate-probe.envNames` and `openclaw gateway call` with
    `--expect-url ws://127.0.0.1:19101`. It fails on any name outside an
    allowlist.
  - Live: the gateway reported the launcher's names plus six it adds
    itself, none carrying a value in: `OPENCLAW_CLI`,
    `OPENCLAW_GATEWAY_PORT` and `OPENCLAW_PATH_BOOTSTRAPPED` from OpenClaw,
    `PWD` and `SHLVL` from the bash wrapper, and `__CF_USER_TEXT_ENCODING`
    from macOS.
  - To prove the check sees loader-injected values: a `.env` holding
    `FAKE_PLANTED_KEY` was put into the marked state folder, and the
    gateway was started directly, bypassing the launcher's refusal.
    `check-env` reported "UNEXPECTED variables in the gateway:
    FAKE_PLANTED_KEY" and exited 4.
  - Run every `openclaw` CLI call for the dev profile the same way: the
    script's `oc` helper does.
- **Memory embeddings.** Memory search is on by default and defaults to the
  `openai` embeddings provider whatever `models.mode` says
  (`DEFAULT_MEMORY_EMBEDDING_PROVIDER` and `produceMemorySearchConfig` in
  `<openclaw>/dist/memory-search-C0yT-zqb.mjs`). The template sets
  `memory.search.provider: "none"`. That provider has no embedding adapter,
  so search is local full-text only (live: `memory.status` reported
  provider `none`, and `memory.search` returned a hit with
  `searchMode: "fts-only"`).
- **Models.** `models.mode: "replace"` with the single `fake` provider means
  agent turns and utility calls go to the fake. Live: every run was answered
  with the fake's scripted text, and runs failed when the fake was stopped.
  The template also sets `models.catalogRefresh.enabled: false`, which stops
  the hosted model catalog fetch.
- **Other network traffic.**
  - `update.checkOnStart: false` stops the update check and the anonymous
    update ping.
  - `discovery.mdns.mode: "off"` stops LAN advertising.
  - Telemetry is off by default, and `DO_NOT_TRACK=1` keeps it off.
  - Bot tools can still reach the internet: `web_fetch`, the browser, MCP
    servers, and exec if approved.

  The template has none of the credentials those would need, but it is not
  a network sandbox.
- **Exec policy.** It is global, `tools.exec.mode: "ask"`, so bots created
  later inherit it. Live: Ledger, created by `seed.mjs` with no override,
  asked for approval for `uname -s` (`security: "allowlist",
  ask: "on-miss"`). Without approval-capable clients, such requests are
  denied as `no-route`. Pixel also denies `exec` outright.
- **Browser.** The template sets `browser.headless: true` and declares one
  profile per bot (`bot-atlas` on 19113, `bot-pixel` on 19114) beside the
  shared `openclaw` profile (19112), for plugin P4.
- **Plugins.** They are loaded from the checkout through `plugins.load.paths`
  and `plugins.entries`. OpenClaw logs that it "can't verify where this
  plugin came from"; that is expected for local paths.

### Other facts the recipe depends on (live unless noted)

- **Custom provider base URL: yes.** `models.providers.<id>.baseUrl` with
  `api: "openai-completions"` (or `openai-responses`) points at any
  OpenAI-compatible server. A non-secret `apiKey` such as `"fake-local"` is
  accepted for loopback URLs (`<openclaw>/docs/gateway/local-models.md`).
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

  After a tool result it replies `Tool <name> returned: <result>`. Utility
  calls (recaps, titles) get a fixed sentence.
- `tools.toolSearch: false` is required. Custom providers otherwise get
  structured Tool Search, which hides real tools behind `tool_search`,
  `tool_describe` and `tool_call`.
- `agents.ownership: "explicit"` is required once there are two or more
  bots.
- Seeding uses the loopback-only trusted backend identity:
  `client.id: "gateway-client"`, `mode: "backend"`, shared token, no
  device. Clawtrate itself must use a device identity.
- **`seed.mjs`.** For each step it:
  - creates the task with `sessions.create`, failing on `runError` or a
    missing `runId`;
  - waits for the run's terminal outcome with `agent.wait {runId}`, failing
    on any status other than `ok`;
  - applies `chat.inject` steps only after the previous run has finished;
  - checks `chat.history` for the expected assistant text or tool result.

  Live, on a fresh profile it printed `ok` for all five tasks:
  - Atlas: "Laptop comparison" (scripted reply plus an injected row);
  - Atlas: "Workspace listing" (`ls` tool);
  - Atlas: "Hand off to the coding agent" (`coder__send_message`, with the
    stand-in MCP server's reply verified);
  - Pixel: "Ask Atlas" (`sessions_send` with `status: "ok"`);
  - Ledger: "Weekly plan".

  It exits 0. With the fake model stopped it exited 1: "run … ended with
  error: The request took too long". Labels must be unique, so run it
  against a fresh profile, or set `SEED_LABEL_SUFFIX`.
- **Stopping.** `dev-gateway.sh stop` sends SIGTERM to the recorded PIDs and
  waits up to 60 s, then sends SIGKILL. In the first round, one gateway took
  more than two minutes to exit after SIGTERM, because plugin service
  disposal ran past its budget. In this round, stops took about 2 s. The
  script records the PID of the exec'd process itself, not a wrapping
  shell; an earlier version recorded the subshell, which would have left
  the gateway running.

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

A real T3 Code integration is **unverified**. The events below come from the
committed stand-in server, not from T3 Code.

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
**unverified**. Its tools will appear as `<server>__<toolName>`, using
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
  - Many Clawtrate flows need `operator.admin`:
    - bot editing and per-bot policy;
    - schedule changes;
    - the built-in browser view;
    - `chat.inject`;
    - choosing a node and per-session tool overrides (`execNode`,
      `toolOverrides` on `sessions.patch` or `sessions.create`);
    - per-session exec settings (`execHost`, `execSecurity`, `execAsk`,
      which exist only on `sessions.patch`).

    A phone holding admin can do anything to the gateway, including config
    writes.

  Mitigations: pair mobile as read, write and approvals by default, with
  admin requested on demand through `device.scopes.requestUpgrade`. Move
  admin-only flows behind narrower plugin methods where possible. P4 shows
  this works for the browser view. A plugin method at a lower scope is
  itself a privilege decision, so review each one.
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
- **Steer semantics.** `sessions.steer` is a deprecated alias for
  `queueMode: "interrupt"`. `chat.send {queueMode:"steer"}` is unverified
  with a real model. With the scripted model it interrupted the running
  reply, and one steer run failed with a "no longer current" error.
- **Memory search defaults to a hosted embeddings provider.** It is
  `openai`, regardless of model routing, and picks up credentials from the
  environment. The development template turns it off
  (`memory.search.provider: "none"`). A real gateway's memory settings decide
  whether memory text leaves the host; Clawtrate's memory view should show
  them.
- **Inherited environment.** Any `openclaw` process (gateway or CLI) started
  from a shell with provider keys can use them. Development tooling must
  start it with a controlled environment (section 4).
- **Personal data in events.** Session rows and message metadata carry the
  gateway owner's display name and avatar URL (`createdActor.label`,
  `senderName`). The probe derived these from the host account. Never
  commit captured event logs or screenshots of real gateways to this
  repository.
- **Gateway shutdown can hang** past SIGTERM (section 4), which matters
  for test harness teardown. Record the PID of the gateway process itself,
  not a wrapping shell.
- **Mobile push** depends on a plugin plus a third-party push service
  (row 16). The official relay is closed to other apps.
- **Browser takeover.** Built in, agent and user input race. P4 gives each
  bot its own browser and blocks that bot while the user holds control. It
  refuses takeover outright while the bot is still acting, and a stuck
  call keeps takeover unavailable. It does not block other operators
  calling `browser.request`. Its frames and
  input go over raw CDP and skip the browser plugin's navigation policy.
  The loopback CDP port is unauthenticated, so any local process on the
  gateway host can already drive the managed browser.
- **Plugin runtime quirks.** The host loads a plugin module more than once,
  and module state is not shared between those loads. Service ids are
  global across plugins. Several runtime
  helpers, including in-process gateway requests, are reserved for bundled
  or official plugins. Plugin designs must be proven on the pinned gateway,
  not inferred from the SDK docs.
